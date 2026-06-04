import { useState, useEffect } from "react";
import {
    createAccountsProvider,
    createPapiProvider,
    hostApi,
    preimageManager,
    requestPermission,
    sandboxTransport,
    type ProductAccount,
} from "@novasamatech/host-api-wrapper";
import { enumValue, RequestCredentialsErr } from "@novasamatech/host-api";
import {
    ContractManager,
    createContractRuntimeFromClient,
    ensureContractAccountMapped,
} from "@parity/product-sdk-contracts";
import { paseo_asset_hub } from "@parity/product-sdk-descriptors/paseo-asset-hub";
import { ss58ToH160 } from "@parity/product-sdk-address";
import { createClient, AccountId, type PolkadotSigner } from "polkadot-api";
import { getWsProvider } from "@polkadot-api/ws-provider";
import { blake2b } from "@noble/hashes/blake2.js";
import { CID } from "multiformats/cid";
import * as raw from "multiformats/codecs/raw";
import type { MultihashDigest } from "multiformats/hashes/interface";

// Paseo Asset Hub Next (v2) — chain reset 2026-06-02.
const PASEO_ASSET_HUB_GENESIS =
    "0xbf0488dbe9daa1de1c08c5f743e26fdc2a4ecd74cf87dd1b4b1eeb99ae4ef19f" as const;
const PASEO_ASSET_HUB_WS = "wss://paseo-asset-hub-next-rpc.polkadot.io";

// ---------------------------------------------------------------------------
// Permissions + resource allowances.
//
// `requestPermission` covers ChainSubmit / PreimageSubmit / StatementSubmit;
// `requestResourceAllocation` covers on-chain quotas (SmartContractAllowance,
// BulletinAllowance, AutoSigning). Paseo Next v2 requires BOTH before any
// Revive.call or preimage submit.
// ---------------------------------------------------------------------------

const _grantedPermissions = new Set<string>();

async function ensurePermission(tag: "ChainSubmit" | "PreimageSubmit" | "StatementSubmit") {
    if (_grantedPermissions.has(tag)) return;
    try {
        const result = await requestPermission({ tag, value: undefined });
        if (result.isOk() && result.value) {
            _grantedPermissions.add(tag);
        } else {
            console.warn(`[Permission] ${tag} denied`);
        }
    } catch (err) {
        console.warn(`[Permission] ${tag} request failed:`, err);
    }
}

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
// Account flow — host-api-wrapper (matches RPS / t3rminal-v1).
//
// We deliberately use @novasamatech/host-api-wrapper rather than the frozen
// @novasamatech/product-sdk. Only host-api-wrapper accepts the
// `"createTransaction"` signerType, which routes via host_create_transaction
// and preserves Paseo Next v2's signed extensions (AsPgas, AsRingAlias,
// EthSetOrigin, AuthorizeCall) — without it every signed tx fails BadProof.
// ---------------------------------------------------------------------------

const accountsProvider = createAccountsProvider(sandboxTransport);
const accountIdCodec = AccountId();

// Polkadot Desktop ≥0.7.5 accepts the raw `window.location.host` for both
// `.dot` domains and `localhost:PORT`. Appending `.dot` would make the signer
// identifier diverge from the host context and the host denies signing.
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

export async function connectAccount(): Promise<void> {
    if (_state.status === "connecting") return;
    setState({ status: "connecting", account: null });

    try {
        const [identifier, derivationIndex] = getAppAccountId();
        const provider = accountsProvider as any;
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
        const signer = provider.getProductAccountSigner(productAccount, "createTransaction");
        const ss58 = accountIdCodec.dec(publicKey);
        const h160Address = ss58ToH160(ss58 as never) as `0x${string}`;

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

        // Kick off resource allowances eagerly so the user only sees one host
        // modal per session (BulletinAllowance + SmartContractAllowance).
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
// Bulletin upload — host preimage path.
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
    await ensurePermission("PreimageSubmit");
    await claimDefaultAllowances();
    const cid = calculateCID(bytes);
    await preimageManager.submit(bytes);
    return cid;
}

// ---------------------------------------------------------------------------
// Contracts (ContractManager.fromLiveClient — RPS pattern).
//
// `fromLiveClient` resolves the deployed contract address from the on-chain
// CDM registry on each init, instead of trusting the snapshot in cdm.json.
// A redeploy is picked up without shipping a new cdm.json. The registry call
// is itself a view query and so requires a mapped origin — we map the user's
// account first with a plain runtime, then build the full ContractManager.
// ---------------------------------------------------------------------------

let _contractManager: ContractManager | null = null;
let _contract: any = null;
let _polkadotClient: ReturnType<typeof createClient> | null = null;
let _cdmJson: any = null;
let _contractInitPromise: Promise<void> | null = null;

export function stageCdmJson(cdmJson: any): void {
    _cdmJson = cdmJson;
}

export async function initContracts(cdmJson: any): Promise<void> {
    stageCdmJson(cdmJson);
}

// `getBestBlocks` retry wrapper — Polkadot Desktop tears down the chainHead
// follow when idle; the first request after wake bails with "No active follow".
async function wakeChainFollow(): Promise<void> {
    if (!_polkadotClient) return;
    try {
        await _polkadotClient.getBestBlocks();
    } catch (err) {
        console.warn("[CDM] wakeChainFollow failed:", err);
    }
}

const NO_FOLLOW_RE = /no active follow/i;

function withFollowRetry<T extends Record<string, any>>(method: T): T {
    const wrap = <Fn extends (...a: any[]) => Promise<any>>(fn: Fn): Fn =>
        (async (...args: any[]) => {
            await wakeChainFollow();
            try {
                return await fn(...args);
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                if (!NO_FOLLOW_RE.test(msg)) throw err;
                console.warn("[CDM] follow lost mid-call, retrying once:", msg);
                await wakeChainFollow();
                return await fn(...args);
            }
        }) as Fn;
    return new Proxy(method, {
        get(target, prop) {
            const v = target[prop as keyof T];
            if (typeof v === "function") return wrap(v.bind(target));
            return v;
        },
    });
}

function wrapContract(contract: any): any {
    return new Proxy(contract, {
        get(target, prop) {
            const m = target[prop];
            if (m && typeof m === "object" && ("query" in m || "tx" in m)) {
                return withFollowRetry(m);
            }
            return m;
        },
    });
}

async function ensureContractsReady(): Promise<void> {
    if (_contractManager || !_cdmJson) return;
    if (_contractInitPromise) return _contractInitPromise;
    _contractInitPromise = (async () => {
        await ensurePermission("ChainSubmit");
        await claimDefaultAllowances();

        // Asset Hub access:
        //   localhost dev — host refuses to follow unregistered domains, so go
        //     direct WS.
        //   deployed .dot — route through host's chainHead follow via
        //     createPapiProvider with WS fallback.
        const isDevHost =
            typeof window !== "undefined" && /^localhost(:\d+)?$/.test(window.location.host);
        const provider = isDevHost
            ? getWsProvider(PASEO_ASSET_HUB_WS)
            : createPapiProvider(PASEO_ASSET_HUB_GENESIS, getWsProvider(PASEO_ASSET_HUB_WS));
        _polkadotClient = createClient(provider);

        await _polkadotClient.getChainSpecData();
        await _polkadotClient.getBestBlocks();

        if (!_state.account) {
            throw new Error("[CDM] Contract init reached without a connected account");
        }

        // Map account BEFORE fromLiveClient. `fromLiveClient` immediately calls
        // `registry.getAddress(...)` as a view, and pallet-revive dry-run-fails
        // that with `Revive::AccountUnmapped` if the query origin isn't mapped.
        const initRuntime = createContractRuntimeFromClient(_polkadotClient, paseo_asset_hub);
        await mapAccountWithRuntime(initRuntime, _state.account);

        _contractManager = await ContractManager.fromLiveClient(
            _cdmJson,
            _polkadotClient,
            paseo_asset_hub,
            {
                defaultOrigin: _state.account.address as never,
                defaultSigner: _state.account.signer,
                registryOrigin: _state.account.address as never,
                libraries: ["@example/feedback"],
            },
        );
        _contract = wrapContract(_contractManager.getContract("@example/feedback"));
        console.log("[CDM] contract ready (live registry resolution)");
    })();
    return _contractInitPromise;
}

export function getContract(): any {
    if (!_cdmJson) return null;
    return new Proxy({}, {
        get(_target, prop) {
            return new Proxy({} as any, {
                get(_t, methodProp) {
                    if (methodProp !== "query" && methodProp !== "tx") return undefined;
                    return async (...args: any[]) => {
                        await ensureContractsReady();
                        if (!_contract) throw new Error("Contract init failed");
                        const real = _contract[prop as string];
                        if (!real) throw new Error(`Unknown method: ${String(prop)}`);
                        return real[methodProp](...args);
                    };
                },
            });
        },
    });
}

// ---------------------------------------------------------------------------
// Revive account mapping (RPS pattern).
//
// pallet-revive on Paseo Next v2 requires every SS58 origin that calls a
// contract to have a `Revive.map_account()` entry. `ensureContractAccountMapped`
// is idempotent — the first call costs one signature, subsequent calls
// short-circuit.
// ---------------------------------------------------------------------------

const _mappedAccounts = new Set<string>();

async function mapAccountWithRuntime(
    runtime: Parameters<typeof ensureContractAccountMapped>[0],
    account: AppAccount,
): Promise<void> {
    if (_mappedAccounts.has(account.address)) return;
    try {
        const mapped = await ensureContractAccountMapped(
            runtime,
            account.address as never,
            account.signer,
        );
        if (mapped === null) {
            console.log(`[Revive] Account ${account.address} already mapped`);
        } else {
            console.log(`[Revive] Account mapped in block #${mapped.block.number}`);
        }
        _mappedAccounts.add(account.address);
    } catch (err) {
        console.error("[Revive] ensureContractAccountMapped failed:", err);
        if (err && typeof err === "object" && "cause" in err) {
            console.error("[Revive] underlying cause:", (err as any).cause);
        }
        throw err;
    }
}

export async function ensureMapping(account: AppAccount): Promise<void> {
    if (_mappedAccounts.has(account.address)) return;
    await ensureContractsReady();
    if (!_contractManager) throw new Error("Contract manager not ready");
    await mapAccountWithRuntime(_contractManager.getRuntime(), account);
}

// Helper for `address`/`bytes20` contract params — accepts both an SS58
// AppAccount and a raw hex string. The product-sdk encoder accepts a `0x...`
// hex string for both Solidity `address` and `bytes20`.
export function asAddress(hexOrAccount: string | AppAccount): `0x${string}` {
    const hex = typeof hexOrAccount === "string" ? hexOrAccount : hexOrAccount.h160Address;
    if (!hex.startsWith("0x")) return ("0x" + hex) as `0x${string}`;
    return hex as `0x${string}`;
}

// ---------------------------------------------------------------------------
// Bulletin reads via public IPFS gateways (Promise.any race).
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
// Misc helpers.
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
