// Crucible reads each setting from its CRUCIBLE_ name.
const PREFIX = 'CRUCIBLE_';

// `suffix` is the name without its prefix, for example 'MCP_LOG'. An empty value counts as not set.
export function readEnvironmentVariable(suffix, env = process.env) {
  const value = env[PREFIX + suffix];
  if (value === undefined || value === '') {
    return undefined;
  }
  return value;
}
