.PHONY: test go-test python-test web-install web-build run pack camera

test: go-test python-test

go-test:
	go test ./...

python-test:
	cd python && PYTHONPATH=src pytest -q

web-install:
	cd web && npm install

web-build:
	cd web && npm run build

run: web-build
	go run ./cmd/safast-server -dir web/dist

pack:
	@test -n "$(FILE)" || (echo "usage: make pack FILE=path/to/file" && exit 2)
	go run ./cmd/safast-pack "$(FILE)"

camera:
	PYTHONPATH=python/src python -m safast.cli scan
