// The inverse kinematics solver types a motion may list, in a leaf module so the MCP server can import the list without
// bundling the motion code. src/agent-motion.js reports it in its type error and tests/mcp-motion-create-forms.test.js
// checks it against the types the backend accepts.
export const IK_SOLVER_TYPE_NAMES = Object.freeze(['two-bone', 'aim', 'chain', 'spline']);
