// this works, but it should be rewritten using
// Fastly library https://github.com/fastly/fastly-js
//
// import Fastly from "fastly";

export { updateService };
export const JsonContentType = "application/json";

let baseURL = "https://api.fastly.com/service/";
const API_BACKEND = "fastly_api";

async function updateService(sid, key, vcl_snippets) {
  let response = "";

  let active_ver = await getActiveService(sid, key);
  let cloned_ver = await cloneActiveVersion(sid, key, active_ver);

  await deleteSnippets(sid, key, cloned_ver, vcl_snippets);
  await uploadSnippets(sid, key, cloned_ver, vcl_snippets);
  await activeVersion(sid, key, cloned_ver);

  return response;
}

async function getActiveService(sid, key) {
  let serviceURL = baseURL + sid;
  let newReq = new Request(serviceURL);

  let beresp = await fetch(newReq, {
    backend: API_BACKEND,
    headers: {
      "Fastly-Key": key,
    },
  });

  let resp = await beresp.json();

  // console.log(JSON.stringify(await beresp.json(), null, 2));
  for (const version of Object.values(resp.versions)) {
    if (version.active == true) {
      console.log("Active version:", version.number);
      return version.number;
    }
  }
  // console.log(await beresp.json());
}

async function cloneActiveVersion(sid, key, ver) {
  let serviceURL = `${baseURL}${sid}/version/${ver}/clone`;
  let newReq = new Request(serviceURL);
  let beresp = await fetch(newReq, {
    backend: API_BACKEND,
    method: "PUT",
    headers: {
      "Fastly-Key": key,
    },
  });
  let resp = await beresp.json();

  console.log("Active version cloned to version", resp.number);
  return resp.number;
}

async function deleteSnippets(sid, key, ver, vcl_snippets) {
  // /service/service_id/version/version_id/snippet/snippet_name
  for (const snippet of Object.keys(vcl_snippets)) {
    let serviceURL = `${baseURL}${sid}/version/${ver}/snippet/${snippet}`;
    let newReq = new Request(serviceURL);
    let beresp = await fetch(newReq, {
      backend: API_BACKEND,
      method: "DELETE",
      headers: {
        "Fastly-Key": key,
      },
    });
    let resp = await beresp.json();
    console.log(`Deleting snippet '${snippet}' - ${beresp.status} ${beresp.statusText}`);
  }
}

async function uploadSnippets(sid, key, ver, vcl_snippets) {
  let serviceURL = `${baseURL}${sid}/version/${ver}/snippet`;
  for (const [snippet, attrs] of Object.entries(vcl_snippets)) {
    let json_snippet = {
      name: snippet,
      dynamic: 0,
      type: attrs.type,
      content: attrs.vcl,
    };

    let body = JSON.stringify(json_snippet);
    let newReq = new Request(serviceURL);
    let beresp = await fetch(newReq, {
      backend: API_BACKEND,
      method: "POST",
      body,
      headers: {
        "Fastly-Key": key,
        "Content-Type": JsonContentType,
        Accept: JsonContentType,
      },
    });
    // eslint-disable-next-line no-unused-vars
    let resp = await beresp.json();
    console.log(`Uploading  snippet '${snippet}' - ${beresp.status} ${beresp.statusText}`);
    // console.log("Uploading snippet `encoded_redirect_table` - " + JSON.stringify(resp, null, 2));
  }
}

async function activeVersion(sid, key, ver) {
  let serviceURL = `${baseURL}${sid}/version/${ver}/activate`;
  let newReq = new Request(serviceURL);
  let beresp = await fetch(newReq, {
    backend: API_BACKEND,
    method: "PUT",
    headers: {
      "Fastly-Key": key,
    },
  });
  let resp = await beresp.json();

  console.log("Activating version", ver, "- ", JSON.stringify(resp, null, 2));
}
