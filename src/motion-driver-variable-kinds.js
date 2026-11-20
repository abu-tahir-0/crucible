// The variables beyond "time" and a node read that a driver expression may use, in a leaf module so the MCP server can
// import the list without bundling the motion code. src/motion-expression.js lists them among its source names, and
// tests/mcp-motion-create-forms.test.js checks the two agree.
export const DRIVER_VARIABLE_KIND_NAMES = Object.freeze(['custom', 'distance', 'rotationDifference']);
