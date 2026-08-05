package main

import (
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"time"
)

func main() {
	addr := flag.String("addr", ":8080", "listen address")
	dir := flag.String("dir", "web/dist", "directory containing the built web app")
	flag.Parse()

	absolute, err := filepath.Abs(*dir)
	if err != nil {
		log.Fatal(err)
	}
	if _, err := os.Stat(absolute); err != nil {
		log.Fatalf("web directory unavailable: %v (run `make web-build` first)", err)
	}

	files := http.FileServer(http.Dir(absolute))
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cross-Origin-Opener-Policy", "same-origin")
		w.Header().Set("Cross-Origin-Embedder-Policy", "require-corp")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("Permissions-Policy", "camera=(self), microphone=(), geolocation=()")
		w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; media-src 'self' blob:; worker-src 'self' blob:; connect-src 'self'")
		if r.URL.Path == "/healthz" {
			w.Header().Set("Content-Type", "application/json")
			fmt.Fprint(w, `{"status":"ok"}`)
			return
		}
		files.ServeHTTP(w, r)
	})

	server := &http.Server{Addr: *addr, Handler: handler, ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 60 * time.Second}
	log.Printf("SAFAST serving %s on http://localhost%s", absolute, *addr)
	log.Fatal(server.ListenAndServe())
}
