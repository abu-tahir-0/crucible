const FIGURE = /^!\[([^\]]*)\]\(([^)]+)\)$/;
const SOURCE = /^([^\s]+)(?:\s+"([^"]*)")?$/;

// Returns { alt, source, caption } for a figure paragraph, or null for a paragraph that merely starts with an image.
export function parseFigure(paragraph) {
  const match = paragraph.match(FIGURE);
  if (!match) return null;
  const source = match[2].match(SOURCE);
  if (!source) return null;
  return { alt: match[1], source: source[1], caption: source[2] ?? null };
}
