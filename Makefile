# Makefile for Vibe Coding Guide

.PHONY: help lint build test clean

help:
	@echo "Makefile for Vibe Coding Guide"
	@echo ""
	@echo "Available commands:"
	@echo "  help     - Show this help message"
	@echo "  lint     - Lint all markdown files"
	@echo "  build    - Build the docs site (VitePress)"
	@echo "  test     - Docs site smoke test (runs build)"
	@echo "  clean    - Remove docs site build artifacts"
	@echo ""

lint:
	@echo "Linting markdown files..."
	@npm install -g markdownlint-cli
	@markdownlint --config .github/lint_config.json '**/*.md'

build:
	@echo "Building the docs site..."
	@npm run build

test:
	@echo "Docs site has no test suite; running build as smoke test..."
	@npm run build

clean:
	@echo "Cleaning up docs site artifacts..."
	@rm -rf .vitepress/dist .vitepress/cache
	@echo "Cleanup complete."