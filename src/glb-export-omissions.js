// What `scene_export_glb` leaves out of the file, as plain strings an agent reads before it ships the GLB.
// A leaf module: the MCP server bundle and the preview page both import it.

/** What the GLB carries and drops, served by scene_capabilities topic export. */
export const GLB_EXPORT_NOTES = Object.freeze({
  writes: [
    'Meshes in their current pose (IK, node overrides and motion at motionTime included), materials, pattern and imported textures, skins and morph weights.',
    'Motion tracks of bone nodes as one 30 frames a second clip named motion.',
    'With clip on an imported asset: that source clip (translation, rotation, scale and morph weights).',
  ],
  drops: [
    'Motion tracks of every other kind: node (non-bone), material, morph, camera, light, sky and effects. The file is a still pose for them.',
    'The camera, and point, spot and area lights. The sun, sky, fog and effects are not written either.',
  ],
  result: 'The result lists each authored thing left out in omitted, such as "motion tracks (3: camera 1, material 1, node 1)", "camera", "lights (2)". An empty omitted list means nothing authored was dropped.',
});

function trackCountsByKind(tracks) {
  const counts = new Map();
  for (const track of tracks) counts.set(track.kind, (counts.get(track.kind) ?? 0) + 1);
  return [...counts].sort(([first], [second]) => first.localeCompare(second)).map(([kind, count]) => `${kind} ${count}`);
}

/**
 * Lists the authored things a GLB export did not write.
 * `writtenBoneIds` names the nodes whose node tracks were baked into the exported clip.
 */
export function omittedFromGlb(recipe, writtenBoneIds = []) {
  const written = new Set(writtenBoneIds);
  const omitted = [];
  const tracks = (recipe.motion?.tracks ?? []).filter(track => !(track.kind === 'node' && written.has(track.id)));
  if (tracks.length) omitted.push(`motion tracks (${tracks.length}: ${trackCountsByKind(tracks).join(', ')})`);
  if (recipe.camera) omitted.push('camera');
  const environment = recipe.environment ?? {};
  const lightCount = (environment.pointLights?.length ?? 0) + (environment.spotLights?.length ?? 0) + (environment.areaLights?.length ?? 0);
  if (lightCount) omitted.push(`lights (${lightCount})`);
  return omitted;
}
