import { useState, useEffect } from "react";
import {
    createAccountsProvider,
    sandboxTransport,
    hostApi,
    preimageManager,
    type ProductAccount,
} from "@novasamatech/host-api-wrapper";
import { enumValue, RequestCredentialsErr } from "@novasamatech/host-api";
// Local PAPI descriptor generated from the live chain via:
//   npx polkadot-api add paseo_asset_hub -w wss://paseo-asset-hub-next-rpc.polkadot.io
// The published @parity/product-sdk-descriptors lags behind the runtime's
// signed-extension set (missing EthSetOrigin / AsPgas / AsRingAlias /
// AuthorizeCall as of 2026-06-02), so every signed tx fails with BadProof
// unless we use a local snapshot. Mirrors t3rminal-v1/lib/contracts/chain.ts.
import { paseo_asset_hub } from "@polkadot-api/descriptors";
import { createClient, AccountId, Binary, type PolkadotSigner, type PolkadotClient, type TypedApi } from "polkadot-api";
import { getWsProvider } from "@polkadot-api/ws-provider";
import { blake2b } from "@noble/hashes/blake2.js";
import { CID } from "multiformats/cid";
import * as raw from "multiformats/codecs/raw";
import type { MultihashDigest } from "multiformats/hashes/interface";
import { ethers } from "ethers";

// Paseo Asset Hub Next (v2) — genesis last refreshed 2026-06-02 (chain reset).
const PASEO_ASSET_HUB_WS = "wss://paseo-asset-hub-next-rpc.polkadot.io";

// ---------------------------------------------------------------------------
// Account flow — direct against host-api-wrapper.
//
// We deliberately use @novasamatech/host-api-wrapper rather than the older
// @novasamatech/product-sdk: product-sdk is frozen at 0.7.9-4 (May 2026).
// host-api-wrapper is the actively-maintained successor — only it has a
// getProductAccountSigner that accepts "createTransaction" and routes via the
// host's host_create_transaction RPC, which preserves Paseo Next v2's signed
// extensions (AsPgas, AsRingAlias, EthSetOrigin, AuthorizeCall). The old PJS-
// adapter path strips them and the chain rejects with BadProof.
// ---------------------------------------------------------------------------

const accountsProvider = createAccountsProvider(sandboxTransport);
const accountIdCodec = AccountId();

// Polkadot Desktop ≥0.7.5 accepts both `.dot` domains and `localhost:PORT`
// identifiers as-is from window.location.host — matches t3rminal-v1 exactly.
function getProductIdentifier(): string | null {
    if (typeof window === "undefined") return null;
    return window.location.host || null;
}

export function getAppAccountId(): [string, number] {
    const identifier = getProductIdentifier() ?? "feedback-board.dot";
    return [identifier, 0];
}

export interface AppAccount {
    address: string;
    h160Address: string;
    publicKey: Uint8Array;
    name: string | null;
    signer: PolkadotSigner;
    productAccountId: [string, number];
    productAccount: ProductAccount;
    getSigner(): PolkadotSigner;
}

interface AccountState {
    status: "idle" | "connecting" | "ready" | "signed-out" | "error";
    account: AppAccount | null;
    error?: string;
}

let _state: AccountState = { status: "idle", account: null };
const _listeners = new Set<(s: AccountState) => void>();

function setState(next: AccountState) {
    _state = next;
    for (const cb of _listeners) cb(next);
}

export function useAccountState(): AccountState {
    const [state, set] = useState<AccountState>(_state);
    useEffect(() => {
        const cb = (s: AccountState) => set(s);
        _listeners.add(cb);
        return () => { _listeners.delete(cb); };
    }, []);
    return state;
}

// Derive H160 from SS58 — matches what Revive.OriginalAccount uses as key.
// Done locally via keccak256 of the 32-byte AccountId public key (skip first
// 12 bytes). Keeps us off the @parity/product-sdk-address import path.
function ss58ToH160(publicKey: Uint8Array): `0x${string}` {
    const hash = ethers.keccak256(publicKey);
    return ("0x" + hash.slice(2 + 24)) as `0x${string}`;
}

export async function connectAccount(): Promise<void> {
    if (_state.status === "connecting") return;
    setState({ status: "connecting", account: null });

    try {
        const [identifier, derivationIndex] = getAppAccountId();
        const provider = accountsProvider as any;
        if (typeof provider.getProductAccount !== "function") {
            setState({ status: "error", account: null, error: "host-api-wrapper getProductAccount missing" });
            return;
        }
        const result = await provider.getProductAccount(identifier, derivationIndex);
        if (result.isErr()) {
            if (result.error instanceof RequestCredentialsErr.NotConnected) {
                setState({ status: "signed-out", account: null });
                return;
            }
            const errMsg = `${(result.error as any)?.tag ?? "Unknown"}: ${(result.error as any)?.value?.reason ?? String(result.error)}`;
            setState({ status: "error", account: null, error: errMsg });
            return;
        }

        const { publicKey } = result.value;
        const productAccount: ProductAccount = { dotNsIdentifier: identifier, derivationIndex, publicKey };
        // "createTransaction" signerType: host receives full extension bytes
        // (extra + additionalSigned) from PAPI's tx-utils, forwards to phone
        // wallet which reconstructs the extrinsic from its own runtime metadata
        // for chain-known extensions (AsPgas, EthSetOrigin, ...) and signs.
        const signer = provider.getProductAccountSigner(productAccount, "createTransaction");
        const ss58 = accountIdCodec.dec(publicKey);
        const h160Address = ss58ToH160(publicKey);

        let displayName: string | null = null;
        try {
            const userIdResult = await provider.getUserId();
            if (userIdResult.isOk()) {
                displayName = (userIdResult.value as any).primaryUsername ?? null;
            }
        } catch { /* optional */ }

        const account: AppAccount = {
            address: ss58,
            h160Address,
            publicKey,
            name: displayName,
            signer,
            productAccountId: [identifier, derivationIndex],
            productAccount,
            getSigner: () => signer,
        };

        setState({ status: "ready", account });

        // Kick off the resource-allowance modal eagerly so the user only sees
        // one host UI per session, before they try to post.
        void claimDefaultAllowances();
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setState({ status: "error", account: null, error: msg });
    }
}

export async function signIn(): Promise<void> {
    await (accountsProvider as any).requestLogin("Sign in to post to the feedback board");
    await connectAccount();
}

// ---------------------------------------------------------------------------
// Resource allowances — required for Paseo Next v2 contracts and Bulletin.
//
// `SmartContractAllowance(0)` is what gates Revive.call — without it AsPgas
// has no PGAS budget and the chain rejects with BadProof.
// `BulletinAllowance` is required by StatementStore (preimage submits).
// `AutoSigning` is best-effort; host returns NotAvailable today.
//
// Mirrors t3rminal-v1/lib/host/allowances.ts.
// ---------------------------------------------------------------------------

let _allowancesPromise: Promise<void> | null = null;

export function claimDefaultAllowances(): Promise<void> {
    if (_allowancesPromise) return _allowancesPromise;
    _allowancesPromise = doClaim().catch(err => {
        _allowancesPromise = null;
        throw err;
    });
    return _allowancesPromise;
}

async function doClaim(): Promise<void> {
    console.info("[Allowance] requesting BulletinAllowance + SmartContractAllowance(0) + AutoSigning");
    const result = await hostApi.requestResourceAllocation(
        enumValue("v1", [
            enumValue("BulletinAllowance", undefined),
            enumValue("SmartContractAllowance", 0),
            enumValue("AutoSigning", undefined),
        ]),
    );
    result.match(
        (response: any) => {
            const outcomes = (response?.value as Array<{ tag?: string }>) ?? [];
            const order = ["BulletinAllowance", "SmartContractAllowance(0)", "AutoSigning"];
            outcomes.forEach((o, i) => console.info(`[Allowance] ${order[i]}: ${o.tag ?? "unknown"}`));
        },
        (err: unknown) => {
            console.warn("[Allowance] requestResourceAllocation failed:", err);
        },
    );
}

// ---------------------------------------------------------------------------
// Bulletin upload — host preimage path.
//
// Goes through preimageManager.submit (host signs and submits
// TransactionStorage.store on Paseo Bulletin Next). Chain rejects with
// "no allowance set for account" unless BulletinAllowance is granted first.
// ---------------------------------------------------------------------------

const BLAKE2B_256_CODE = 0xb220;

function encodeVarint(value: number): Uint8Array {
    const bytes: number[] = [];
    let num = value;
    while (num >= 0x80) {
        bytes.push((num & 0x7f) | 0x80);
        num >>= 7;
    }
    bytes.push(num & 0x7f);
    return new Uint8Array(bytes);
}

export function calculateCID(bytes: Uint8Array): string {
    const hash = blake2b(bytes, { dkLen: 32 });
    const codeBytes = encodeVarint(BLAKE2B_256_CODE);
    const lengthBytes = encodeVarint(hash.length);
    const multihash = new Uint8Array(codeBytes.length + lengthBytes.length + hash.length);
    multihash.set(codeBytes, 0);
    multihash.set(lengthBytes, codeBytes.length);
    multihash.set(hash, codeBytes.length + lengthBytes.length);
    const digest: MultihashDigest = {
        code: BLAKE2B_256_CODE,
        size: hash.length,
        bytes: multihash,
        digest: hash,
    };
    return CID.createV1(raw.code, digest).toString();
}

export async function uploadToBulletin(_account: AppAccount, bytes: Uint8Array): Promise<string> {
    await claimDefaultAllowances();
    const cid = calculateCID(bytes);
    await preimageManager.submit(bytes);
    return cid;
}

// ---------------------------------------------------------------------------
// Chain client (WS-direct, lazy singleton).
//
// host-api-wrapper's createPapiProvider routes chain JSON-RPC through the
// deprecated host_jsonrpc_message_* channel. Polkadot Desktop's new
// chainConnectionManager (≥0.7.5) doesn't wire that through, so PAPI's
// chainHead follow stalls or serves stale metadata → BadProof. Going direct
// to WSS is the only path that works today. Signing still goes through the
// host product-account signer; only chain RPC bypasses the host. Matches
// t3rminal-v1/lib/host/provider.ts.
// ---------------------------------------------------------------------------

interface PaseoChainAPI {
    assetHub: TypedApi<typeof paseo_asset_hub>;
    raw: { assetHub: PolkadotClient };
}

let _chainApi: PaseoChainAPI | null = null;

async function getChainAPI(): Promise<PaseoChainAPI> {
    if (_chainApi) return _chainApi;
    const provider = getWsProvider(PASEO_ASSET_HUB_WS);
    const client = createClient(provider);
    _chainApi = {
        assetHub: client.getTypedApi(paseo_asset_hub),
        raw: { assetHub: client },
    };
    console.log("[Chain] Paseo Asset Hub Next ready (direct WSS)");
    return _chainApi;
}

// ---------------------------------------------------------------------------
// Contract ABI / address loading from cdm.json
// ---------------------------------------------------------------------------

let _contractAddress: `0x${string}` | null = null;
let _iface: ethers.Interface | null = null;
let _cdmJson: any = null;

export function stageCdmJson(cdmJson: any): void {
    _cdmJson = cdmJson;
    // cdm 0.8.18 uses a flat contracts map (no target-hash nesting). Older
    // 0.7.x had `contracts[targetHash][pkg]`; we still fall through to that
    // shape so the same code works with either.
    const contracts = cdmJson?.contracts ?? {};
    const direct = contracts["@example/feedback"];
    if (direct?.address && direct?.abi) {
        _contractAddress = direct.address as `0x${string}`;
        _iface = new ethers.Interface(direct.abi);
        return;
    }
    for (const targetHash of Object.keys(contracts)) {
        const entry = contracts[targetHash]?.["@example/feedback"];
        if (entry?.address && entry?.abi) {
            _contractAddress = entry.address as `0x${string}`;
            _iface = new ethers.Interface(entry.abi);
            return;
        }
    }
    console.warn("[CDM] No deployed @example/feedback found in cdm.json");
}

export async function initContracts(cdmJson: any): Promise<void> {
    stageCdmJson(cdmJson);
}

// ---------------------------------------------------------------------------
// Contract reads — ReviveApi.call with Alice as origin.
//
// Alice is always mapped; view functions don't depend on caller identity.
// ---------------------------------------------------------------------------

const READ_ORIGIN = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";

async function readContract(functionName: string, args: unknown[]): Promise<ethers.Result> {
    if (!_iface || !_contractAddress) {
        throw new Error("Contract ABI/address not loaded — did cdm install run?");
    }
    const api = await getChainAPI();
    const calldata = _iface.encodeFunctionData(functionName, args);
    const result = await api.assetHub.apis.ReviveApi.call(
        READ_ORIGIN,
        _contractAddress,
        BigInt(0),
        undefined,
        undefined,
        Binary.fromHex(calldata as `0x${string}`),
    );
    if (!result.result.success) {
        throw new Error(`Contract read ${functionName} failed: ${JSON.stringify(result.result.value)}`);
    }
    const hex = Binary.toHex(result.result.value.data);
    return _iface.decodeFunctionResult(functionName, hex);
}

// ---------------------------------------------------------------------------
// Revive mapping probe — t3rminal-v1 pattern.
//
// ReviveApi.address(ss58) returns the H160 the runtime would derive.
// Revive.OriginalAccount(h160) returns Some(ss58) iff the binding exists.
// If unmapped, we submit Revive.map_account() before the first Revive.call.
// ---------------------------------------------------------------------------

const _mappedAccounts = new Set<string>();

async function isAccountMapped(account: AppAccount): Promise<boolean> {
    if (_mappedAccounts.has(account.address)) return true;
    try {
        const api = await getChainAPI();
        const unsafeApi = api.raw.assetHub.getUnsafeApi();
        const reviveApi = (unsafeApi.apis as any).ReviveApi as
            | { address(ss58: string): Promise<string | null> }
            | undefined;
        const h160 = await reviveApi?.address(account.address);
        if (!h160) return false;
        const original = await (unsafeApi.query as any).Revive?.OriginalAccount?.getValue(h160);
        const mapped = original != null;
        if (mapped) _mappedAccounts.add(account.address);
        return mapped;
    } catch (err) {
        console.warn("[Revive] mapping probe failed, assume unmapped:", err);
        return false;
    }
}

// ---------------------------------------------------------------------------
// signSubmitAndWatch with dual resolution path + 120s stall watchdog.
//
// PAPI sometimes never delivers txBestBlocksState through Polkadot Desktop's
// host bridge for Paseo Next v2. We resolve on EITHER:
//   - PAPI's txBestBlocksState.found, OR
//   - An inclusion oracle (poll contract state) returning true.
// Mirrors t3rminal-v1/lib/contracts/revive-bulletin-index.ts.
// ---------------------------------------------------------------------------

function watchTx(
    tx: any,
    signer: PolkadotSigner,
    label: string,
    inclusionOracle?: () => Promise<boolean>,
): Promise<`0x${string}`> {
    const POLL_INTERVAL_MS = 1500;
    const STALL_TIMEOUT_MS = 120_000;
    const submitOpts = { mortality: { mortal: true as const, period: 256 } };

    return new Promise<`0x${string}`>((resolve, reject) => {
        let settled = false;
        let pollStopped = false;
        let broadcastedHash: `0x${string}` | undefined;
        let stallTimer: ReturnType<typeof setTimeout> | undefined;

        const clearStall = () => { if (stallTimer) { clearTimeout(stallTimer); stallTimer = undefined; } };
        const armStall = () => {
            clearStall();
            stallTimer = setTimeout(() => {
                if (settled) return;
                settled = true;
                pollStopped = true;
                try { sub.unsubscribe(); } catch { /* noop */ }
                reject(new Error(`[${label}] stalled: no inclusion within ${STALL_TIMEOUT_MS}ms`));
            }, STALL_TIMEOUT_MS);
        };
        const succeed = (hash: `0x${string}`) => {
            if (settled) return;
            settled = true;
            pollStopped = true;
            clearStall();
            resolve(hash);
        };

        const sub = tx.signSubmitAndWatch(signer, submitOpts).subscribe({
            next(ev: any) {
                if (ev.type === "signed") console.log(`[${label}] signed`);
                if (ev.type === "broadcasted") {
                    broadcastedHash = ev.txHash;
                    console.log(`[${label}] broadcasted, watchdog armed`);
                    armStall();
                    if (inclusionOracle) {
                        void (async () => {
                            while (!pollStopped && !settled) {
                                try {
                                    if (await inclusionOracle()) {
                                        console.log(`[${label}] oracle: landed`);
                                        if (broadcastedHash) succeed(broadcastedHash);
                                        return;
                                    }
                                    armStall();
                                } catch (err) {
                                    console.warn(`[${label}] oracle threw:`, err);
                                }
                                await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
                            }
                        })();
                    }
                }
                if (ev.type === "txBestBlocksState" && ev.found) {
                    armStall();
                    if (ev.ok === false) {
                        if (settled) return;
                        settled = true;
                        pollStopped = true;
                        clearStall();
                        try { sub.unsubscribe(); } catch { /* noop */ }
                        reject(new Error(`[${label}] dispatch error: ${JSON.stringify(ev.dispatchError)}`));
                        return;
                    }
                    console.log(`[${label}] txBestBlocksState.found in ${ev.block?.hash?.slice(0, 12)}`);
                    succeed((ev.block?.hash ?? broadcastedHash ?? "0x") as `0x${string}`);
                }
                if (ev.type === "finalized") {
                    console.log(`[${label}] finalized`);
                    if (!settled) succeed((ev.block?.hash ?? broadcastedHash ?? "0x") as `0x${string}`);
                    try { sub.unsubscribe(); } catch { /* noop */ }
                }
            },
            error(err: unknown) {
                if (settled) return;
                settled = true;
                pollStopped = true;
                clearStall();
                console.error(`[${label}] subscription error:`, err);
                reject(err instanceof Error ? err : new Error(String(err)));
            },
        });
    });
}

// ---------------------------------------------------------------------------
// Public mapping + write helpers.
// ---------------------------------------------------------------------------

export async function ensureMapping(account: AppAccount): Promise<void> {
    if (_mappedAccounts.has(account.address)) return;
    await claimDefaultAllowances();
    const mapped = await isAccountMapped(account);
    if (mapped) return;

    const api = await getChainAPI();
    const unsafeApi = api.raw.assetHub.getUnsafeApi();
    const reviveTx = (unsafeApi as any).tx.Revive;

    console.log("[Revive] submitting map_account…");
    try {
        await watchTx(reviveTx.map_account(), account.signer, "Revive.map_account");
        _mappedAccounts.add(account.address);
        console.log("[Revive] mapped");
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/AccountAlreadyMapped/i.test(msg)) {
            _mappedAccounts.add(account.address);
            console.log("[Revive] already mapped (race)");
            return;
        }
        throw err;
    }
}

async function writeContract(
    functionName: string,
    args: unknown[],
    account: AppAccount,
    inclusionOracle?: () => Promise<boolean>,
): Promise<`0x${string}`> {
    if (!_iface || !_contractAddress) {
        throw new Error("Contract ABI/address not loaded — did cdm install run?");
    }
    await claimDefaultAllowances();
    await ensureMapping(account);

    const api = await getChainAPI();
    const unsafeApi = api.raw.assetHub.getUnsafeApi();
    const reviveTx = (unsafeApi as any).tx.Revive;
    const calldata = _iface.encodeFunctionData(functionName, args);

    const tx = reviveTx.call({
        dest: _contractAddress,
        value: BigInt(0),
        weight_limit: { ref_time: BigInt("50000000000"), proof_size: BigInt("1000000") },
        storage_deposit_limit: BigInt("10000000000"),
        data: Binary.fromHex(calldata as `0x${string}`),
    });

    return watchTx(tx, account.signer, `Revive.call(${functionName})`, inclusionOracle);
}

// ---------------------------------------------------------------------------
// Public contract handle — keeps the `fb.methodName.query(...) / .tx(...)`
// shape used by App.tsx.
// ---------------------------------------------------------------------------

export function getContract(): any {
    if (!_cdmJson) return null;
    return new Proxy({}, {
        get(_target, prop) {
            const fnName = String(prop);
            return {
                query: async (...args: any[]) => {
                    const decoded = await readContract(fnName, args);
                    const value = decoded.length === 1 ? decoded[0] : decoded;
                    return { success: true, value };
                },
                tx: async (...args: any[]) => {
                    const opts = args[args.length - 1] as { signer: PolkadotSigner; origin: string; oracle?: () => Promise<boolean> };
                    const callArgs = args.slice(0, -1);
                    const account = _state.account;
                    if (!account) throw new Error("No account connected");
                    return writeContract(fnName, callArgs, account, opts.oracle);
                },
            };
        },
    });
}

// ---------------------------------------------------------------------------
// Bulletin reads via public IPFS gateways (Promise.any race)
// ---------------------------------------------------------------------------

const GATEWAYS = [
    "https://paseo-bulletin-next-ipfs.polkadot.io/ipfs/",
    "https://dweb.link/ipfs/",
    "https://ipfs.io/ipfs/",
    "https://nftstorage.link/ipfs/",
] as const;

export const IPFS_GATEWAY = GATEWAYS[0];

export async function fetchFromGateway(cid: string, timeoutMs = 30000): Promise<Uint8Array> {
    const master = new AbortController();
    const timer = setTimeout(() => master.abort(), timeoutMs);
    try {
        const winner = await Promise.any(
            GATEWAYS.map(async gw => {
                const resp = await fetch(gw + cid, { signal: master.signal });
                if (!resp.ok) throw new Error(`${gw} -> ${resp.status}`);
                return new Uint8Array(await resp.arrayBuffer());
            }),
        );
        master.abort();
        return winner;
    } finally {
        clearTimeout(timer);
    }
}

export async function fetchJsonFromBulletin<T = unknown>(cid: string): Promise<T> {
    const bytes = await fetchFromGateway(cid);
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
}

// ---------------------------------------------------------------------------
// Misc helpers
// ---------------------------------------------------------------------------

export const short = (addr: string) => addr.slice(0, 6) + "..." + addr.slice(-4);

export async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    return Promise.race([
        promise,
        new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms),
        ),
    ]);
}

export const MAX_FEEDBACK_LENGTH = 280;

const STICKY_PALETTE = [
    "#fff59d", "#f8bbd0", "#bbdefb", "#c8e6c9", "#ffe0b2", "#d1c4e9",
];

function hashString(s: string, seed: number): number {
    let h = seed;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return Math.abs(h);
}

export function colorForCid(cid: string): string {
    return STICKY_PALETTE[hashString(cid, 7) % STICKY_PALETTE.length];
}

export function tiltForCid(cid: string): number {
    const h = hashString(cid, 13);
    return ((h % 1000) / 100) - 5;
}

export function formatTime(unixSec: number): string {
    if (!unixSec) return "";
    const d = new Date(unixSec * 1000);
    const diffMs = Date.now() - d.getTime();
    const min = Math.floor(diffMs / 60000);
    if (min < 1) return "just now";
    if (min < 60) return `${min}m ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}h ago`;
    const day = Math.floor(hr / 24);
    if (day < 7) return `${day}d ago`;
    return d.toLocaleDateString();
}
