// Quackoscope host (Rust) -- transport layer.
//
// An RFC 6455 WebSocket server over std::net, one OS thread per connection.
// It is written out here rather than pulled from a crate so that the whole
// host builds from two dependencies -- the openDAQ bindings and serde_json --
// and so that the framing the frontend sees is visible in this repository.
//
// Nothing in this file mentions the openDAQ crate or the M1 service DTOs: it
// speaks text frames, binary frames and the transport::wire envelopes only.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::Value as Json;

use super::wire::{self, Outcome};

/// The GUID RFC 6455 section 1.3 appends to Sec-WebSocket-Key before hashing.
const WEBSOCKET_ACCEPT_GUID: &str = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/// Largest inbound message this host will assemble, in bytes. A control-plane
/// request is a few hundred bytes; anything past this is a client defect or an
/// attack, and the socket is closed rather than grown.
const MAX_INBOUND_MESSAGE_BYTES: usize = 1 << 20;

/// What the service layer implements so the transport can drive it.
pub trait ConnectionHandler: Send + Sync {
    fn on_open(&self, connection: &Arc<Connection>);
    fn on_close(&self, connection: &Arc<Connection>);
    fn on_request(&self, connection: &Arc<Connection>, method: &str, params: &Json) -> Outcome;
}

/// One live WebSocket. Cloneable across threads: the subscription pump threads
/// hold an `Arc<Connection>` and push binary frames through the same writer the
/// request thread uses, serialised by `writer`.
pub struct Connection {
    id: u64,
    peer: String,
    writer: Mutex<TcpStream>,
    open: AtomicBool,
}

impl Connection {
    pub fn id(&self) -> u64 {
        self.id
    }

    pub fn peer(&self) -> &str {
        &self.peer
    }

    pub fn is_open(&self) -> bool {
        self.open.load(Ordering::SeqCst)
    }

    /// Send one text frame (opcode 0x1).
    pub fn send_text(&self, text: &str) {
        self.send_frame(0x1, text.as_bytes());
    }

    /// Send one binary frame (opcode 0x2).
    pub fn send_binary(&self, bytes: &[u8]) {
        self.send_frame(0x2, bytes);
    }

    fn send_close(&self) {
        // 1000 = normal closure, RFC 6455 section 7.4.1.
        self.send_frame(0x8, &1000u16.to_be_bytes());
    }

    fn send_frame(&self, opcode: u8, payload: &[u8]) {
        if !self.open.load(Ordering::SeqCst) {
            return;
        }

        let mut frame = Vec::with_capacity(payload.len() + 10);
        frame.push(0x80 | opcode); // FIN set, no extensions, no fragmentation
        // Server-to-client frames are never masked (RFC 6455 section 5.1).
        if payload.len() < 126 {
            frame.push(payload.len() as u8);
        } else if payload.len() <= u16::MAX as usize {
            frame.push(126);
            frame.extend_from_slice(&(payload.len() as u16).to_be_bytes());
        } else {
            frame.push(127);
            frame.extend_from_slice(&(payload.len() as u64).to_be_bytes());
        }
        frame.extend_from_slice(payload);

        let mut writer = match self.writer.lock() {
            Ok(writer) => writer,
            Err(poisoned) => poisoned.into_inner(),
        };
        if let Err(e) = writer.write_all(&frame).and_then(|()| writer.flush()) {
            self.open.store(false, Ordering::SeqCst);
            eprintln!(
                "[transport] connection {} ({}): writing a {}-byte opcode-0x{opcode:X} frame failed: {e}",
                self.id,
                self.peer,
                payload.len()
            );
        }
    }
}

/// A parsed inbound frame header plus its unmasked payload.
struct InboundFrame {
    fin: bool,
    opcode: u8,
    payload: Vec<u8>,
}

pub struct WebSocketServer {
    listener: TcpListener,
    websocket_path: String,
    handler: Arc<dyn ConnectionHandler>,
    next_connection_id: AtomicU64,
}

impl WebSocketServer {
    /// Bind the listening socket now, so a port clash is reported before the
    /// host announces that it is listening.
    pub fn bind(
        address: &str,
        port: u16,
        websocket_path: &str,
        handler: Arc<dyn ConnectionHandler>,
    ) -> std::io::Result<WebSocketServer> {
        let listener = TcpListener::bind((address, port))?;
        Ok(WebSocketServer {
            listener,
            websocket_path: websocket_path.to_string(),
            handler,
            next_connection_id: AtomicU64::new(1),
        })
    }

    pub fn local_address(&self) -> std::io::Result<std::net::SocketAddr> {
        self.listener.local_addr()
    }

    /// Accept forever, one thread per connection.
    pub fn serve_until_process_exit(self) -> ! {
        let server = Arc::new(self);
        loop {
            match server.listener.accept() {
                Ok((stream, peer)) => {
                    let server = Arc::clone(&server);
                    let id = server.next_connection_id.fetch_add(1, Ordering::SeqCst);
                    std::thread::Builder::new()
                        .name(format!("quackoscope-websocket-connection-{id}"))
                        .spawn(move || server.run_connection(id, stream, peer.to_string()))
                        .expect("spawning a WebSocket connection thread");
                }
                Err(e) => eprintln!("[transport] accept() on the listening socket failed: {e}"),
            }
        }
    }

    fn run_connection(&self, id: u64, stream: TcpStream, peer: String) {
        let _ = stream.set_nodelay(true);

        let write_half = match stream.try_clone() {
            Ok(clone) => clone,
            Err(e) => {
                eprintln!("[transport] connection {id} ({peer}): could not clone the socket for writing: {e}");
                return;
            }
        };
        let mut reader = BufReader::new(stream);

        let request_line_and_headers = match read_http_request_head(&mut reader) {
            Ok(head) => head,
            Err(e) => {
                eprintln!("[transport] connection {id} ({peer}): reading the HTTP request head failed: {e}");
                return;
            }
        };

        let mut write_half = write_half;
        let key = match self.check_upgrade(&request_line_and_headers) {
            Ok(key) => key,
            Err(refusal) => {
                eprintln!("[transport] connection {id} ({peer}): {refusal}");
                let body = format!("{refusal}\n");
                let response = format!(
                    "HTTP/1.1 400 Bad Request\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = write_half.write_all(response.as_bytes());
                let _ = write_half.flush();
                let _ = write_half.shutdown(Shutdown::Both);
                return;
            }
        };

        let accept = websocket_accept_value(&key);
        let response = format!(
            "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {accept}\r\n\r\n"
        );
        if let Err(e) = write_half
            .write_all(response.as_bytes())
            .and_then(|()| write_half.flush())
        {
            eprintln!("[transport] connection {id} ({peer}): writing the 101 response failed: {e}");
            return;
        }

        println!(
            "[transport] connection {id} ({peer}): upgraded to WebSocket on {}; Sec-WebSocket-Key {key} -> Sec-WebSocket-Accept {accept}",
            self.websocket_path
        );

        let connection = Arc::new(Connection {
            id,
            peer: peer.clone(),
            writer: Mutex::new(write_half),
            open: AtomicBool::new(true),
        });

        self.handler.on_open(&connection);
        self.pump_frames(&connection, &mut reader);
        connection.open.store(false, Ordering::SeqCst);
        self.handler.on_close(&connection);

        let closing = match connection.writer.lock() {
            Ok(writer) => writer.try_clone(),
            Err(poisoned) => poisoned.into_inner().try_clone(),
        };
        if let Ok(socket) = closing {
            let _ = socket.shutdown(Shutdown::Both);
        }
        println!("[transport] connection {id} ({peer}): closed");
    }

    /// The upgrade preconditions of RFC 6455 section 4.2.1, plus the path this
    /// host serves. On refusal the message names exactly what was wrong.
    fn check_upgrade(&self, head: &HttpRequestHead) -> Result<String, String> {
        if head.method != "GET" {
            return Err(format!(
                "the WebSocket upgrade needs a GET; the request line was \"{} {} {}\"",
                head.method, head.target, head.version
            ));
        }
        let path = head.target.split('?').next().unwrap_or(&head.target);
        if path != self.websocket_path {
            return Err(format!(
                "this host serves the WebSocket at {} only; the request asked for \"{}\"",
                self.websocket_path, head.target
            ));
        }
        match head.headers.get("upgrade") {
            Some(value) if value.eq_ignore_ascii_case("websocket") => {}
            Some(value) => return Err(format!("Upgrade header is \"{value}\", not \"websocket\"")),
            None => return Err("no Upgrade header in the request".to_string()),
        }
        match head.headers.get("sec-websocket-version") {
            Some(value) if value.trim() == "13" => {}
            Some(value) => {
                return Err(format!(
                    "Sec-WebSocket-Version is \"{value}\"; this host implements RFC 6455 version 13 only"
                ))
            }
            None => return Err("no Sec-WebSocket-Version header in the request".to_string()),
        }
        match head.headers.get("sec-websocket-key") {
            Some(key) if !key.trim().is_empty() => Ok(key.trim().to_string()),
            _ => Err("no Sec-WebSocket-Key header in the request".to_string()),
        }
    }

    /// Read frames, reassemble fragmented messages, answer control frames, and
    /// hand every complete text message to the handler as a wire request.
    fn pump_frames(&self, connection: &Arc<Connection>, reader: &mut BufReader<TcpStream>) {
        let mut message = Vec::new();
        let mut message_opcode: u8 = 0;

        loop {
            let frame = match read_frame(reader) {
                Ok(Some(frame)) => frame,
                Ok(None) => return, // peer closed the TCP connection
                Err(e) => {
                    eprintln!(
                        "[transport] connection {} ({}): reading a frame failed: {e}",
                        connection.id, connection.peer
                    );
                    return;
                }
            };

            match frame.opcode {
                0x8 => {
                    connection.send_close();
                    return;
                }
                0x9 => {
                    connection.send_frame(0xA, &frame.payload); // pong echoes the ping body
                    continue;
                }
                0xA => continue, // an unsolicited pong; nothing to do
                0x0 | 0x1 | 0x2 => {}
                other => {
                    eprintln!(
                        "[transport] connection {} ({}): opcode 0x{other:X} is not one this host handles; closing",
                        connection.id, connection.peer
                    );
                    connection.send_close();
                    return;
                }
            }

            if frame.opcode != 0x0 {
                message.clear();
                message_opcode = frame.opcode;
            }
            if message.len() + frame.payload.len() > MAX_INBOUND_MESSAGE_BYTES {
                eprintln!(
                    "[transport] connection {} ({}): an inbound message passed {MAX_INBOUND_MESSAGE_BYTES} bytes; closing",
                    connection.id, connection.peer
                );
                connection.send_close();
                return;
            }
            message.extend_from_slice(&frame.payload);

            if !frame.fin {
                continue;
            }

            if message_opcode == 0x2 {
                eprintln!(
                    "[transport] connection {} ({}): dropping a {}-byte client binary frame; the M1 contract's binary plane is server-to-client only",
                    connection.id,
                    connection.peer,
                    message.len()
                );
                message.clear();
                continue;
            }

            let text = match String::from_utf8(std::mem::take(&mut message)) {
                Ok(text) => text,
                Err(e) => {
                    eprintln!(
                        "[transport] connection {} ({}): a text frame was not valid UTF-8: {e}",
                        connection.id, connection.peer
                    );
                    connection.send_close();
                    return;
                }
            };

            self.answer_one_request(connection, &text);
        }
    }

    fn answer_one_request(&self, connection: &Arc<Connection>, text: &str) {
        let request = match wire::decode_request(text) {
            Ok(request) => request,
            Err(error_envelope) => {
                connection.send_text(&error_envelope.to_string());
                return;
            }
        };

        let outcome = self
            .handler
            .on_request(connection, &request.method, &request.params);

        let envelope = match outcome {
            Outcome::Result(result) => wire::encode_result(request.id, result),
            Outcome::Failure { code, detail } => wire::encode_error(request.id, &code, &detail),
        };
        connection.send_text(&envelope.to_string());
    }
}

struct HttpRequestHead {
    method: String,
    target: String,
    version: String,
    /// Header names lowercased; values trimmed.
    headers: HashMap<String, String>,
}

fn read_http_request_head(reader: &mut BufReader<TcpStream>) -> std::io::Result<HttpRequestHead> {
    let mut request_line = String::new();
    if reader.read_line(&mut request_line)? == 0 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::UnexpectedEof,
            "the peer closed the socket before sending a request line",
        ));
    }
    let mut parts = request_line.trim_end().split_whitespace();
    let method = parts.next().unwrap_or_default().to_string();
    let target = parts.next().unwrap_or_default().to_string();
    let version = parts.next().unwrap_or_default().to_string();

    let mut headers = HashMap::new();
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line)? == 0 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::UnexpectedEof,
                "the peer closed the socket in the middle of the request headers",
            ));
        }
        let line = line.trim_end_matches(['\r', '\n']);
        if line.is_empty() {
            break;
        }
        if let Some((name, value)) = line.split_once(':') {
            headers.insert(name.trim().to_ascii_lowercase(), value.trim().to_string());
        }
    }

    Ok(HttpRequestHead {
        method,
        target,
        version,
        headers,
    })
}

/// One RFC 6455 frame. `Ok(None)` means the peer closed the TCP connection
/// cleanly between frames.
fn read_frame(reader: &mut BufReader<TcpStream>) -> std::io::Result<Option<InboundFrame>> {
    let mut first_two = [0u8; 2];
    match reader.read_exact(&mut first_two) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e),
    }

    let fin = first_two[0] & 0x80 != 0;
    let opcode = first_two[0] & 0x0F;
    let masked = first_two[1] & 0x80 != 0;
    let short_length = (first_two[1] & 0x7F) as usize;

    let length = match short_length {
        126 => {
            let mut extended = [0u8; 2];
            reader.read_exact(&mut extended)?;
            u16::from_be_bytes(extended) as usize
        }
        127 => {
            let mut extended = [0u8; 8];
            reader.read_exact(&mut extended)?;
            let length = u64::from_be_bytes(extended);
            if length > MAX_INBOUND_MESSAGE_BYTES as u64 {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    format!(
                        "a frame announced {length} payload bytes, past this host's {MAX_INBOUND_MESSAGE_BYTES}-byte limit"
                    ),
                ));
            }
            length as usize
        }
        other => other,
    };

    if !masked {
        // RFC 6455 section 5.1: every client-to-server frame is masked.
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("an inbound opcode-0x{opcode:X} frame of {length} bytes carried no mask"),
        ));
    }

    let mut mask = [0u8; 4];
    reader.read_exact(&mut mask)?;

    let mut payload = vec![0u8; length];
    reader.read_exact(&mut payload)?;
    for (index, byte) in payload.iter_mut().enumerate() {
        *byte ^= mask[index % 4];
    }

    Ok(Some(InboundFrame {
        fin,
        opcode,
        payload,
    }))
}

/// base64(SHA-1(key + GUID)), the Sec-WebSocket-Accept of RFC 6455 section 4.2.2.
fn websocket_accept_value(key: &str) -> String {
    let mut hashed_input = String::with_capacity(key.len() + WEBSOCKET_ACCEPT_GUID.len());
    hashed_input.push_str(key);
    hashed_input.push_str(WEBSOCKET_ACCEPT_GUID);
    base64_standard(&sha1_digest(hashed_input.as_bytes()))
}

/// SHA-1 (FIPS 180-4). Present because the accept value of the WebSocket
/// handshake is defined in terms of it; it is used for nothing else.
fn sha1_digest(message: &[u8]) -> [u8; 20] {
    let mut h: [u32; 5] = [0x67452301, 0xEFCDAB89, 0x98BADCFE, 0x10325476, 0xC3D2E1F0];

    let mut padded = message.to_vec();
    padded.push(0x80);
    while padded.len() % 64 != 56 {
        padded.push(0);
    }
    padded.extend_from_slice(&((message.len() as u64) * 8).to_be_bytes());

    for block in padded.chunks_exact(64) {
        let mut w = [0u32; 80];
        for (index, word) in block.chunks_exact(4).enumerate() {
            w[index] = u32::from_be_bytes([word[0], word[1], word[2], word[3]]);
        }
        for index in 16..80 {
            w[index] = (w[index - 3] ^ w[index - 8] ^ w[index - 14] ^ w[index - 16]).rotate_left(1);
        }

        let (mut a, mut b, mut c, mut d, mut e) = (h[0], h[1], h[2], h[3], h[4]);
        for (index, word) in w.iter().enumerate() {
            let (f, k) = match index {
                0..=19 => ((b & c) | ((!b) & d), 0x5A827999u32),
                20..=39 => (b ^ c ^ d, 0x6ED9EBA1),
                40..=59 => ((b & c) | (b & d) | (c & d), 0x8F1BBCDC),
                _ => (b ^ c ^ d, 0xCA62C1D6),
            };
            let temp = a
                .rotate_left(5)
                .wrapping_add(f)
                .wrapping_add(e)
                .wrapping_add(k)
                .wrapping_add(*word);
            e = d;
            d = c;
            c = b.rotate_left(30);
            b = a;
            a = temp;
        }
        h[0] = h[0].wrapping_add(a);
        h[1] = h[1].wrapping_add(b);
        h[2] = h[2].wrapping_add(c);
        h[3] = h[3].wrapping_add(d);
        h[4] = h[4].wrapping_add(e);
    }

    let mut digest = [0u8; 20];
    for (index, word) in h.iter().enumerate() {
        digest[index * 4..index * 4 + 4].copy_from_slice(&word.to_be_bytes());
    }
    digest
}

/// RFC 4648 standard base64 with padding.
fn base64_standard(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

    let mut out = String::with_capacity((bytes.len() + 2) / 3 * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let triple = (b0 << 16) | (b1 << 8) | b2;

        out.push(ALPHABET[(triple >> 18) as usize & 0x3F] as char);
        out.push(ALPHABET[(triple >> 12) as usize & 0x3F] as char);
        out.push(if chunk.len() > 1 {
            ALPHABET[(triple >> 6) as usize & 0x3F] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            ALPHABET[triple as usize & 0x3F] as char
        } else {
            '='
        });
    }
    out
}

#[cfg(test)]
mod rfc6455_handshake_vectors {
    use super::{base64_standard, sha1_digest, websocket_accept_value};

    #[test]
    fn sha1_matches_the_fips_180_4_example_digests() {
        assert_eq!(
            sha1_digest(b"abc")
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect::<String>(),
            "a9993e364706816aba3e25717850c26c9cd0d89d"
        );
        assert_eq!(
            sha1_digest(b"")
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect::<String>(),
            "da39a3ee5e6b4b0d3255bfef95601890afd80709"
        );
    }

    #[test]
    fn base64_matches_the_rfc_4648_test_vectors() {
        assert_eq!(base64_standard(b"f"), "Zg==");
        assert_eq!(base64_standard(b"fo"), "Zm8=");
        assert_eq!(base64_standard(b"foo"), "Zm9v");
        assert_eq!(base64_standard(b"foobar"), "Zm9vYmFy");
    }

    #[test]
    fn accept_value_matches_the_rfc_6455_section_1_3_example() {
        assert_eq!(
            websocket_accept_value("dGhlIHNhbXBsZSBub25jZQ=="),
            "s3pPLMBiTxaQ9kYGzzhZRbK+xOo="
        );
    }
}
