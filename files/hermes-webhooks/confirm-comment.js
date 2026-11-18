const { statusCode, body } = $input.first().json;
const candidate = $('Verify and filter').first().json;
const ignored = { status: 200, result: 'ignored' };
const unavailable = { status: 502, result: 'plane_unavailable' };
const blank = (value) => value === null || value === '';

function confirmComment() {
  if (statusCode === 404) return ignored;
  if (statusCode !== 200 || !body || !Object.hasOwn(body, 'edited_at') ||
      !Object.hasOwn(body, 'external_source') || !Object.hasOwn(body, 'external_id')) {
    return unavailable;
  }
  if (body.id !== candidate.commentId || body.issue !== candidate.issueId ||
      body.project !== candidate.projectId || body.workspace !== candidate.workspaceId ||
      body.actor !== candidate.actorId || body.created_by !== candidate.actorId ||
      body.edited_at !== null || !blank(body.external_source) || !blank(body.external_id)) {
    return ignored;
  }
  return { issueUrl: candidate.issueUrl };
}

return [{ json: confirmComment() }];
