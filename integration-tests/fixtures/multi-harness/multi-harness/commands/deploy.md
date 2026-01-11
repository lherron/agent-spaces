# /deploy

Deploy the application to the specified environment.

## Usage

```
/deploy [environment]
```

## Arguments

- `environment`: Target environment (staging, production). Defaults to staging.

## What it does

1. Runs the build process
2. Runs all tests
3. Deploys to the specified environment
4. Reports deployment status
