.PHONY: install
install:
	bun i

.PHONY: dev
dev:
	NODE_ENV='development' ./node_modules/.bin/concurrently -n "server,client" -c "bgBlue.bold,bgMagenta.bold" "CGO_ENABLED=0 go run main.go serve" "./node_modules/.bin/vite --port 8091"

.PHONY: build
build:
	rm -f ./dist/serve
	./node_modules/.bin/tsc -b
	./node_modules/.bin/vite build
	CGO_ENABLED=0 go build -o dist/serve main.go

.PHONY: run
run:
	./dist/serve serve --dir ./pb_data

.PHONY: deploy
deploy:
	rm -f ./dist/serve
	./node_modules/.bin/tsc -b
	./node_modules/.bin/vite build
	CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o dist/servelinux main.go
	scp -i ~/.ssh/cyoa ./dist/servelinux root@194.54.156.199:/root/cyoa-cafe/serve
	rm -f ./dist/servelinux
	ssh -i ~/.ssh/cyoa root@194.54.156.199 'systemctl restart cyoa-cafe'
