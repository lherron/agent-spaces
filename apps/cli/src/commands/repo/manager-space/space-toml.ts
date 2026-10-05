import type { SpaceFile } from '../manager-space-content'

export const SPACE_TOML: SpaceFile = {
  path: 'space.toml',
  content: `# Agent Spaces Manager
# Built-in management space for creating and managing spaces in the shared spaces root

schema = 1
id = "agent-spaces-manager"
version = "1.0.0"
description = "Management space for creating and managing Agent Spaces"

[plugin]
name = "agent-spaces-manager"
description = "Tools and guidance for authoring and managing Agent Spaces"
license = "MIT"
keywords = ["management", "authoring", "scaffolding"]
`,
}
