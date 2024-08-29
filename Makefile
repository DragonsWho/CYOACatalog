.PHONY: install
install:
	bun i

.PHONY: dev
dev:
	NODE_ENV='development' ./node_modules/.bin/concurrently -n "server,client" -c "bgBlue.bold,bgMagenta.bold" "CGO_ENABLED=0 go run main.go serve" "bun run dev --port 8091"

.PHONY: build
build:
	rm -f ./dist/serve
	bun run build
	CGO_ENABLED=0 go build -o dist/serve main.go

.PHONY: run
run:
	./dist/serve serve --dir ./pb_data
