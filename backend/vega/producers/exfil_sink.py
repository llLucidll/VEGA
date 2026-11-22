"""Harmless local upload sink on port 8443 for VM exfiltration demos."""

from __future__ import annotations

import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class SinkHandler(BaseHTTPRequestHandler):
    def do_POST(self) -> None:
        if self.path != "/upload":
            self.send_error(404)
            return
        if self.server.allow_source and self.client_address[0] not in self.server.allow_source:
            self.send_error(403)
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self.send_error(400)
            return
        if not 0 < length <= 256 * 1024:
            self.send_error(413)
            return
        self.connection.settimeout(5)
        if len(self.rfile.read(length)) != length:
            self.send_error(400)
            return
        body = f'{{"status":"sink_received","bytes":{length}}}\n'.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format: str, *args: object) -> None:
        print(f"[vega-exfil-sink] {self.address_string()} - {format % args}")


def main() -> None:
    parser = argparse.ArgumentParser(description="VEGA harmless demo upload sink")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8443)
    parser.add_argument("--allow-source", action="append", default=[], help="Restrict uploads to these IPs")
    args = parser.parse_args()

    server = ThreadingHTTPServer((args.host, args.port), SinkHandler)
    server.allow_source = set(args.allow_source)
    print(f"[vega-exfil-sink] listening on http://{args.host}:{args.port}/upload")
    server.serve_forever()


if __name__ == "__main__":
    main()
