PREFIX ?= /usr/local
BINDIR ?= $(PREFIX)/bin
BINARY := dist/lawnchy
SOURCES := $(wildcard src/*.ts src/*.tsx)
# OpenTUI only imports these when OPENTUI_LIBC=musl, but on Linux the bundler still
# tries to resolve them, and glibc installs don't have them. Binaries target glibc.
EXTERNALS := --external @opentui/core-linux-x64-musl --external @opentui/core-linux-arm64-musl

.PHONY: build test install uninstall clean

build: $(BINARY)

$(BINARY): $(SOURCES) package.json bun.lock
	bun install --frozen-lockfile
	bun build src/index.tsx --compile --production $(EXTERNALS) --outfile $(BINARY)

test:
	bun install --frozen-lockfile
	bun run typecheck
	bun test

# `install` replaces the file rather than writing into it, which macOS requires:
# overwriting a running or previously run signed binary in place gets it killed.
install: $(BINARY)
	install -d $(DESTDIR)$(BINDIR)
	install -m 755 $(BINARY) $(DESTDIR)$(BINDIR)/lawnchy

uninstall:
	rm -f $(DESTDIR)$(BINDIR)/lawnchy

clean:
	rm -rf dist
