export function projectFromLocation() {
  const id=new URL(window.location.href).searchParams.get('project');
  return id && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id) ? id : null;
}

export function rememberProject(id:string|null) {
  const url=new URL(window.location.href);
  if (id) url.searchParams.set('project',id);
  else url.searchParams.delete('project');
  window.history.replaceState(null,'',url);
}
