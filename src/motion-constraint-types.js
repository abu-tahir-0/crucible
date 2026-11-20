// The node constraint types a motion may list, in a leaf module so the MCP server can import the list without bundling
// the constraint code. tests/mcp-motion-create-forms.test.js checks it equals CONSTRAINT_TYPES of src/node-constraints.js.
export const CONSTRAINT_TYPE_NAMES = Object.freeze([
  'copy_location', 'copy_rotation', 'copy_scale', 'limit_location', 'limit_rotation', 'track_to', 'child_of', 'floor',
  'copy_transforms', 'limit_distance', 'limit_scale', 'stretch_to', 'locked_track', 'transformation', 'action',
  'maintain_volume', 'damped_track', 'pivot', 'follow_path', 'clamp_to', 'shrinkwrap', 'armature',
]);
