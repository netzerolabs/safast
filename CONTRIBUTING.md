# Contributing

Wire compatibility is the main constraint. Changes to frame bytes, deterministic
PRNG operations, robust-soliton CDF construction, container fields, or hash
validation require matching updates and golden vectors in Go, Python, and
TypeScript.

Before opening a pull request:

```bash
go test ./...
cd python && PYTHONPATH=src pytest -q
cd ../web && npm install && npm run build
```

Use focused commits, explain benchmark hardware for performance claims, and
never describe the optical channel as encrypted unless an actual authenticated
encryption layer has been added and reviewed.
