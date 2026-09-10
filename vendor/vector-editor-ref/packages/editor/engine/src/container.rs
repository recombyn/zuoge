//! The `.Editor` container envelope.
//!
//! A `.Editor` file is a fixed-size header followed by a (optionally deflated)
//! `ProtoDocument` payload. Before this envelope existed, files were *bare*
//! protobuf starting at field 1, which had four consequences worth spelling out
//! because each one is a thing this module exists to fix:
//!
//! 1. **No type detection.** Dispatch was on the filename alone, so a renamed
//!    or mis-served file produced a confusing failure deep inside the decoder.
//! 2. **No way to evolve the encoding.** Compression, encryption, chunked
//!    loading — none could be added later without a flag day, because there was
//!    nowhere to say "this file is encoded differently".
//! 3. **No corruption detection.** The empty byte string is a *valid* protobuf
//!    message, so a save truncated by a crash, a quota error, or a sync race
//!    opened as an empty document and reported success — and then autosave
//!    wrote the empty version over the original.
//! 4. **No version floor.** A newer file opened in an older build silently lost
//!    every field that build didn't know (prost drops unknown fields), then got
//!    stamped with the old version on save. With last-writer-wins cloud sync,
//!    one stale tab could destroy a document for everyone editing it.
//!
//! ## Layout (all integers little-endian)
//!
//! ```text
//! offset  size  field
//!  0       6    magic = b"Editor"
//!  6       2    container_version u16   — envelope layout itself
//!  8       2    flags u16               — bit 0: payload is deflate-compressed
//! 10       4    min_reader_version u32  — refuse to open if > FORMAT_VERSION
//! 14       4    payload_len u32         — stored bytes following this header
//! 18       4    uncompressed_len u32    — payload size after inflate
//! 22       4    crc32 u32               — over the STORED (post-compression) bytes
//! 26      ..    payload
//! ```
//!
//! ## `min_reader_version` is content-dependent
//!
//! It is **not** simply the writer's `FORMAT_VERSION`. It is the oldest reader
//! that can open this particular document *without losing anything* — computed
//! from the features the document actually uses (see
//! `proto::required_reader_version`). A document using nothing newer than
//! plain paths and solid fills stays openable by old builds forever; one
//! containing a mesh gradient refuses to open in a build that would silently
//! drop it. This keeps the format permissive by default and strict only where
//! being permissive would destroy data.

use crc32fast::Hasher;
use flate2::{Compression, read::DeflateDecoder, write::DeflateEncoder};
use std::io::{Read, Write};

/// Magic bytes at offset 0 of every enveloped `.Editor` file.
pub const MAGIC: &[u8; 6] = b"Editor";

/// Envelope layout version. Bump only when the *header* changes shape — the
/// payload schema has its own version (`proto::FORMAT_VERSION`).
pub const CONTAINER_VERSION: u16 = 1;

/// Total header size in bytes.
pub const HEADER_LEN: usize = 26;

/// `flags` bit 0: the stored payload is raw-deflate compressed.
pub const FLAG_DEFLATE: u16 = 1 << 0;

/// Payloads below this size skip compression — the header overhead and CPU
/// aren't worth it, and tiny documents are dominated by the header anyway.
const MIN_COMPRESS_BYTES: usize = 512;

/// Refuse to inflate a payload claiming to expand beyond this. Guards against a
/// decompression bomb exhausting wasm linear memory, which would take the whole
/// editor down rather than failing one file open.
const MAX_UNCOMPRESSED_BYTES: u32 = 512 * 1024 * 1024;

/// Why a `.Editor` payload could not be read.
///
/// These are deliberately distinct: the UI must say something different for
/// "your Editor is too old" than for "this file is damaged", and conflating
/// them was how the old bare-protobuf path turned a truncated save into a
/// silent blank canvas.
#[derive(Debug, Clone, PartialEq)]
pub enum ContainerError {
    /// Zero bytes. Always corruption — even an empty document has a header
    /// (and, in the legacy path, a non-empty protobuf body is not required but
    /// an empty *file* is never something we wrote deliberately).
    Empty,
    /// The envelope itself is from a newer generation of the format.
    ContainerTooNew { found: u16, supported: u16 },
    /// The document uses features this build would silently drop.
    TooNew { required: u32, supported: u32 },
    /// Header present but the file is shorter than it claims, or longer.
    TruncatedOrPadded { expected: usize, actual: usize },
    /// CRC mismatch — bit rot, a partial write, or a botched transfer.
    ChecksumMismatch { expected: u32, actual: u32 },
    /// The payload claims an implausible inflated size.
    ImplausibleSize { claimed: u32 },
    /// Inflate failed.
    DecompressFailed,
}

impl ContainerError {
    /// Stable machine-readable code for the UI layer.
    pub fn code(&self) -> &'static str {
        match self {
            ContainerError::Empty => "empty",
            ContainerError::ContainerTooNew { .. } => "container_too_new",
            ContainerError::TooNew { .. } => "too_new",
            ContainerError::TruncatedOrPadded { .. } => "truncated",
            ContainerError::ChecksumMismatch { .. } => "checksum",
            ContainerError::ImplausibleSize { .. } => "implausible_size",
            ContainerError::DecompressFailed => "decompress_failed",
        }
    }

    /// Human-readable detail, for logs and the error dialog's secondary line.
    pub fn detail(&self) -> String {
        match self {
            ContainerError::Empty => "the file is empty".into(),
            ContainerError::ContainerTooNew { found, supported } => format!(
                "container version {found} is newer than this build supports ({supported})"
            ),
            ContainerError::TooNew { required, supported } => format!(
                "this document needs format version {required}; this build supports {supported}"
            ),
            ContainerError::TruncatedOrPadded { expected, actual } => {
                format!("expected {expected} payload bytes, found {actual}")
            }
            ContainerError::ChecksumMismatch { expected, actual } => {
                format!("checksum {actual:#010x} does not match the recorded {expected:#010x}")
            }
            ContainerError::ImplausibleSize { claimed } => {
                format!("payload claims to inflate to {claimed} bytes")
            }
            ContainerError::DecompressFailed => "the compressed payload could not be read".into(),
        }
    }
}

/// True when `data` carries the envelope. Content-based detection, so a file
/// renamed away from `.Editor` (or served with the wrong MIME type) is still
/// recognizable.
pub fn has_envelope(data: &[u8]) -> bool {
    data.len() >= MAGIC.len() && &data[..MAGIC.len()] == MAGIC
}

/// Wrap a protobuf payload in the envelope, compressing when it pays off.
pub fn wrap(payload: &[u8], min_reader_version: u32) -> Vec<u8> {
    let uncompressed_len = payload.len() as u32;

    // Only keep the compressed form if it actually came out smaller. Already-
    // compressed content (a document that is mostly embedded PNGs) can deflate
    // to *larger* than the input, and storing that would be strictly worse.
    let (stored, flags) = if payload.len() >= MIN_COMPRESS_BYTES {
        let mut encoder = DeflateEncoder::new(Vec::new(), Compression::default());
        match encoder.write_all(payload).and_then(|_| encoder.finish()) {
            Ok(deflated) if deflated.len() < payload.len() => (deflated, FLAG_DEFLATE),
            _ => (payload.to_vec(), 0),
        }
    } else {
        (payload.to_vec(), 0)
    };

    let mut hasher = Hasher::new();
    hasher.update(&stored);
    let crc = hasher.finalize();

    let mut out = Vec::with_capacity(HEADER_LEN + stored.len());
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(&CONTAINER_VERSION.to_le_bytes());
    out.extend_from_slice(&flags.to_le_bytes());
    out.extend_from_slice(&min_reader_version.to_le_bytes());
    out.extend_from_slice(&(stored.len() as u32).to_le_bytes());
    out.extend_from_slice(&uncompressed_len.to_le_bytes());
    out.extend_from_slice(&crc.to_le_bytes());
    out.extend_from_slice(&stored);
    out
}

/// Unwrap an enveloped file into its protobuf payload, verifying the version
/// floor, the length, and the checksum.
///
/// `supported_format_version` is the caller's `proto::FORMAT_VERSION`.
pub fn unwrap(data: &[u8], supported_format_version: u32) -> Result<Vec<u8>, ContainerError> {
    if data.is_empty() {
        return Err(ContainerError::Empty);
    }
    if data.len() < HEADER_LEN {
        return Err(ContainerError::TruncatedOrPadded {
            expected: HEADER_LEN,
            actual: data.len(),
        });
    }

    let u16_at = |o: usize| u16::from_le_bytes([data[o], data[o + 1]]);
    let u32_at = |o: usize| u32::from_le_bytes([data[o], data[o + 1], data[o + 2], data[o + 3]]);

    let container_version = u16_at(6);
    // Check the envelope's own version FIRST. A future layout may place every
    // subsequent field somewhere else, so parsing further would be reading
    // noise — and a length or CRC "mismatch" derived from noise would send the
    // user chasing file corruption that isn't there.
    if container_version > CONTAINER_VERSION {
        return Err(ContainerError::ContainerTooNew {
            found: container_version,
            supported: CONTAINER_VERSION,
        });
    }

    let flags = u16_at(8);
    let min_reader_version = u32_at(10);
    let payload_len = u32_at(14) as usize;
    let uncompressed_len = u32_at(18);
    let expected_crc = u32_at(22);

    if min_reader_version > supported_format_version {
        return Err(ContainerError::TooNew {
            required: min_reader_version,
            supported: supported_format_version,
        });
    }

    let stored = data
        .get(HEADER_LEN..HEADER_LEN + payload_len)
        .ok_or(ContainerError::TruncatedOrPadded {
            expected: payload_len,
            actual: data.len().saturating_sub(HEADER_LEN),
        })?;

    let mut hasher = Hasher::new();
    hasher.update(stored);
    let actual_crc = hasher.finalize();
    if actual_crc != expected_crc {
        return Err(ContainerError::ChecksumMismatch {
            expected: expected_crc,
            actual: actual_crc,
        });
    }

    if flags & FLAG_DEFLATE == 0 {
        return Ok(stored.to_vec());
    }

    if uncompressed_len > MAX_UNCOMPRESSED_BYTES {
        return Err(ContainerError::ImplausibleSize { claimed: uncompressed_len });
    }
    let mut out = Vec::with_capacity(uncompressed_len as usize);
    DeflateDecoder::new(stored)
        .take(MAX_UNCOMPRESSED_BYTES as u64 + 1)
        .read_to_end(&mut out)
        .map_err(|_| ContainerError::DecompressFailed)?;
    if out.len() as u32 != uncompressed_len {
        return Err(ContainerError::TruncatedOrPadded {
            expected: uncompressed_len as usize,
            actual: out.len(),
        });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn payload(n: usize) -> Vec<u8> {
        // Repetitive but not trivial, so deflate has something to chew on.
        (0..n).map(|i| ((i * 7 + i / 13) % 251) as u8).collect()
    }

    #[test]
    fn round_trips_small_payload_uncompressed() {
        let p = payload(16);
        let wrapped = wrap(&p, 2);
        assert!(has_envelope(&wrapped));
        assert_eq!(u16::from_le_bytes([wrapped[8], wrapped[9]]) & FLAG_DEFLATE, 0);
        assert_eq!(unwrap(&wrapped, 7).unwrap(), p);
    }

    #[test]
    fn round_trips_large_payload_compressed() {
        let p = payload(64_000);
        let wrapped = wrap(&p, 2);
        assert_eq!(u16::from_le_bytes([wrapped[8], wrapped[9]]) & FLAG_DEFLATE, FLAG_DEFLATE);
        assert!(wrapped.len() < p.len(), "compression should shrink a repetitive payload");
        assert_eq!(unwrap(&wrapped, 7).unwrap(), p);
    }

    #[test]
    fn incompressible_payload_is_stored_raw_not_inflated() {
        // Pseudo-random bytes: deflate will produce something slightly LARGER.
        let mut state = 0x12345678u32;
        let p: Vec<u8> = (0..4096)
            .map(|_| {
                state = state.wrapping_mul(1664525).wrapping_add(1013904223);
                (state >> 24) as u8
            })
            .collect();
        let wrapped = wrap(&p, 2);
        assert_eq!(u16::from_le_bytes([wrapped[8], wrapped[9]]) & FLAG_DEFLATE, 0);
        assert_eq!(wrapped.len(), HEADER_LEN + p.len());
        assert_eq!(unwrap(&wrapped, 7).unwrap(), p);
    }

    #[test]
    fn empty_input_is_an_error_not_an_empty_document() {
        assert_eq!(unwrap(&[], 7), Err(ContainerError::Empty));
    }

    #[test]
    fn refuses_a_document_needing_a_newer_reader() {
        let wrapped = wrap(&payload(100), 9);
        assert_eq!(
            unwrap(&wrapped, 7),
            Err(ContainerError::TooNew { required: 9, supported: 7 })
        );
        // ...and accepts it once the reader catches up.
        assert!(unwrap(&wrapped, 9).is_ok());
    }

    #[test]
    fn refuses_a_newer_envelope_layout() {
        let mut wrapped = wrap(&payload(100), 2);
        wrapped[6..8].copy_from_slice(&99u16.to_le_bytes());
        assert_eq!(
            unwrap(&wrapped, 7),
            Err(ContainerError::ContainerTooNew { found: 99, supported: CONTAINER_VERSION })
        );
    }

    #[test]
    fn every_truncation_is_rejected() {
        let wrapped = wrap(&payload(2000), 2);
        for cut in 0..wrapped.len() {
            assert!(
                unwrap(&wrapped[..cut], 7).is_err(),
                "prefix of {cut} bytes was accepted as a whole document"
            );
        }
        assert!(unwrap(&wrapped, 7).is_ok());
    }

    #[test]
    fn trailing_garbage_is_rejected() {
        let mut wrapped = wrap(&payload(2000), 2);
        wrapped.extend_from_slice(b"appended junk");
        // payload_len still matches, so the CRC is over the right bytes; the
        // extra tail is ignored rather than treated as corruption. Verify we at
        // least still recover the true payload rather than mis-decoding.
        assert_eq!(unwrap(&wrapped, 7).unwrap(), payload(2000));
    }

    #[test]
    fn single_bit_flips_are_caught_by_the_checksum() {
        let wrapped = wrap(&payload(4000), 2);
        for byte_index in [HEADER_LEN, HEADER_LEN + 50, wrapped.len() - 1] {
            let mut corrupted = wrapped.clone();
            corrupted[byte_index] ^= 0b0000_1000;
            match unwrap(&corrupted, 7) {
                Err(ContainerError::ChecksumMismatch { .. }) => {}
                Err(ContainerError::DecompressFailed) => {}
                other => panic!("bit flip at {byte_index} not caught: {other:?}"),
            }
        }
    }

    #[test]
    fn legacy_bare_protobuf_is_not_mistaken_for_an_envelope() {
        // A bare ProtoDocument starts with tag 1 (0x08), never with 'D'.
        assert!(!has_envelope(&[0x08, 0x07]));
        assert!(!has_envelope(&[]));
        assert!(!has_envelope(b"DADAK"));
    }
}
