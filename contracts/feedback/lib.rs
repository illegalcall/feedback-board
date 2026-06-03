#![cfg_attr(not(feature = "abi-gen"), no_main, no_std)]

#[pvm_contract_sdk::contract(allocator = "pico", allocator_size = 65536)]
mod feedback {
    use alloc::string::String;
    use pvm_contract_sdk::{Address, Lazy, Mapping};

    pvm_contract_sdk::sol_revert_enum! {
        pub enum Error {
            FeedbackNotFound(FeedbackNotFound),
        }
    }

    #[derive(Debug, pvm_contract_sdk::SolError)]
    pub struct FeedbackNotFound;

    pub struct Feedback {
        #[slot(0)]
        feedback_count: Lazy<u64>,
        #[slot(1)]
        feedback_cids: Mapping<u64, String>,
        #[slot(2)]
        feedback_creators: Mapping<u64, [u8; 20]>,
    }

    impl Feedback {
        #[pvm_contract_sdk::constructor]
        pub fn new(&mut self) {
            self.feedback_count.set(&0);
        }

        #[pvm_contract_sdk::method]
        pub fn post_feedback(&mut self, cid: String) -> u64 {
            let caller = self.caller();
            let id = self.feedback_count.get();

            self.feedback_cids.insert(&id, &cid);
            self.feedback_creators.insert(&id, &caller.0);
            self.feedback_count.set(&(id + 1));

            id
        }

        #[pvm_contract_sdk::method]
        pub fn get_feedback_count(&self) -> u64 {
            self.feedback_count.get()
        }

        #[pvm_contract_sdk::method]
        pub fn get_feedback_cid(&self, id: u64) -> Result<String, Error> {
            if id >= self.feedback_count.get() {
                return Err(FeedbackNotFound.into());
            }
            Ok(self.feedback_cids.get(&id))
        }

        #[pvm_contract_sdk::method]
        pub fn get_feedback_creator(&self, id: u64) -> Result<Address, Error> {
            if id >= self.feedback_count.get() {
                return Err(FeedbackNotFound.into());
            }
            Ok(Address(self.feedback_creators.get(&id)))
        }

        fn caller(&self) -> Address {
            let mut buf = [0u8; 20];
            self.host().caller(&mut buf);
            Address(buf)
        }
    }
}
