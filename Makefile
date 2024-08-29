.PHONY: install
install: package.json
	bun i

.PHONY: dev
dev: install
	CGO_ENABLED=0 go run main.go serve

.PHONY: build
build: install
	CGO_ENABLED=0 go build -o bin/serve main.go
