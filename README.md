# Spaces Registry

This is an Agent Spaces registry. Add spaces under `spaces/`.

## Structure

```
spaces/
  my-space/
    space.toml
    commands/
    skills/
    ...
registry/
  dist-tags.json
```

## Publishing

Use `asp repo publish <space-id> --tag vX.Y.Z` to create a version tag.

## Manager Space

The `agent-spaces-manager` space is pre-installed to help you create and manage spaces.
Run `asp run space:agent-spaces-manager@stable` to get started.
