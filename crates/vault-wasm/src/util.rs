//! Helpers shared by the binding modules.

/// Standard base64 (binary payloads cross the boundary inside JSON).
pub fn b64encode(bytes: &[u8]) -> String {
    vault_publish::base64_encode(bytes)
}

/// Standard or URL-safe base64; padding and whitespace are ignored.
pub fn b64decode(s: &str) -> Vec<u8> {
    vault_publish::base64_decode(s)
}
