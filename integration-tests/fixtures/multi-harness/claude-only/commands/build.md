# /build

Run the project build process.

## Usage

```
/build [--watch]
```

## Arguments

- `--watch`: Enable watch mode for continuous builds

## What it does

1. Runs `bun run build` in the project root
2. Reports any compilation errors
3. Optionally watches for changes in watch mode
