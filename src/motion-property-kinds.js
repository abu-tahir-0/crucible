// The kinds a custom motion property may have, in a leaf module so the MCP server can import the list without bundling the motion code.
// src/motion-properties.js builds PROPERTY_KINDS from it, so scene_create and set-motion accept the same kinds.
export const MOTION_PROPERTY_KIND_NAMES = Object.freeze(['number', 'vector', 'color']);
