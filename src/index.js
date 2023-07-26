// known types of `matchRules`:
// `erMatchRule` - `Edge Redirects` - Supported
// `frMatchRule` - `Forward Rewrite,` not supported
// `asMatchRule` - `Audience Segmentation`, not supported

import {
  Router
} from "@fastly/expressly";

const API_BACKEND = "fastly_api";
const router = new Router();

let baseURL = "https://api.fastly.com/service/";

// a JSON string must be treatened 
String.prototype.escapeSpecialChars = function () {
  return this.replace(/\\n/g, "\\n")
    .replace(/\\'/g, "\\'")
    .replace(/\\"/g, '\\"')
    .replace(/\\&/g, "\\&")
    .replace(/\\r/g, "\\r")
    .replace(/\\t/g, "\\t")
    .replace(/\\b/g, "\\b")
    .replace(/\\f/g, "\\f");
};

const JsonContentType = "application/json";

// define a template, which we will populate with code later.
let vcl_snippets = {
  "cloudlet_redirect_table": {
    "type": "init",
    "vcl": ""
  },
  "cloudlet_redirect_logic": {
    "type": "recv",
    "vcl": ""
  },
  "cloudlet_redirect_handler": {
    "type": "error",
    "vcl": ""
  }
};

let cloudlet_redirect_table = "\n// cloudlet_redirect_table begins\n\ntable path_redirect {\n";
let cloudlet_redirect_logic = `\n// cloudlet_redirect_logic begins

declare local var.cust_location STRING;
declare local var.cust_priority STRING;
declare local var.cust_status_code STRING;
declare local var.cust_use_query_string STRING;
declare local var.cust_full_path STRING;

set var.cust_full_path = "https://" + req.http.host + req.url.path;\n`;

let cloudlet_redirect_handler = `  # Cloudlet Redirect handler
  if (obj.status == 777) {
    set obj.status = std.atoi(req.http.X-Response-Code);
    if (obj.status == 301 || obj.status == 302) {
      set obj.http.Location = obj.response;
      set obj.response = if(obj.status == 301, "Moved Permanently", "Found");
    }
    synthetic if(req.http.X-Response-Body, req.http.X-Response-Body, "");
    return(deliver);
  }
`;

// If the URL begins with /cloudlet/er/service/
router.post("/cloudlet/er/service/:serviceId([^/]+)", async (req, res) => {
  let serviceId = req.params.serviceId;
  let key = req.headers.get("Fastly-Key");
  if (key == null) {
    let resp = new Response("`Fastly-Key` header must be speficied\n");
    // Construct a new response using the new data but original status.
    res.send(resp);
  }

  // Parse the JSON response from the backend.
  const data = await req.json();

  // console.log("data received", data);

  // define placeholders go populate later
  let strict_redirects = [];
  let response = "";

  // this going to enumerate custom conditions 
  let first_if = "0";

  for (const [key, value] of Object.entries(data.matchRules)) {
    // console.log(key + " -> " + JSON.stringify(data.matchRules[key], null, 2));
    let status_code = typeof value.statusCode == 'undefined' ? '301' : value.statusCode;
    if (value.type == "erMatchRule") {
      // console.log("erMatchRule rule found");

      if (value.matchURL !== null) {
        // A strict match case, use edge dictionary table
        let cust_use_query_string
        if (typeof value.useIncomingQueryString !== "undefined" && value.useIncomingQueryString == true) {
          cust_use_query_string = "useQS";
        } else {
          cust_use_query_string = "noQS";
        }
        if (strict_redirects.includes(value.matchURL)) {
          response += `Entry ${key} - ${value.matchURL} is a duplicate, ignored.\n`;
        } else {
          strict_redirects.push(value.matchURL);
          cloudlet_redirect_table += `  "${value.matchURL}" : "${key}|${status_code}|${cust_use_query_string}|${value.redirectURL}",\n`;
        }
      } else {

        // add conditition header
        // the first custom condition should start with `if` while rest should be `elseif`
        cloudlet_redirect_logic += first_if == 0 ? '\n  if ' : ' elseif ';
        first_if++;

        cloudlet_redirect_logic += '('.repeat(value.matches.length);
        for (const [matches_idx, matches_val] of Object.entries(value.matches)) {
          console.log(`'matchType' = ${matches_val.matchType}`);
          switch (matches_val.matchType) {
            case 'regex': {
              // 2+ match rules are treated as a logical AND
              if (matches_idx > 0) {
                cloudlet_redirect_logic += ') && (';
              }
              if (matches_val.negate) {
                cloudlet_redirect_logic += `var.cust_full_path !~ "${matches_val.matchValue}"`;
              } else {
                cloudlet_redirect_logic += `var.cust_full_path ~ "${matches_val.matchValue}"`;
              }
              break;
            }
            case 'query': {
              let [qs_name, qs_value] = matches_val.matchValue.split(/=(.*)/s);
              let match_list = qs_value.split(' ');

              let match_operand = `querystring.get(req.url, "${qs_name}")`;
              build_condition(match_list, matches_idx, match_operand, matches_val.negate);
              break;
            }
            case 'hostname': {
              let match_list = matches_val.matchValue.split(' ');

              build_condition(match_list, matches_idx, 'req.http.host', matches_val.negate);
              break;
            }
            case 'path': {
              let match_list = matches_val.matchValue.split(' ');

              build_condition(match_list, matches_idx, 'req.url.path', matches_val.negate);
              break;
            }
            case 'cookie': {
              let [c_name, c_value] = matches_val.matchValue.split(/=(.*)/s);
              let match_list = c_value.split(' ');

              build_condition(match_list, matches_idx, `req.http.cookie:${c_name}`, matches_val.negate);
              break;
            }

            case 'extension': {
              let match_list = matches_val.matchValue.split(' ');

              build_condition(match_list, matches_idx, 'req.url.ext', matches_val.negate);
              break;
            }
            default:
              console.log('Unknown `matchType: `', matches_idx.matchType, 'skipped');
          }
        }

        // prepare rule footer
        // add an indicator to `useIncomingQueryString` value, if present
        let cust_use_query_string;
        if (typeof value.useIncomingQueryString !== "undefined" && value.useIncomingQueryString == true) {
          cust_use_query_string = "useQS";
        } else {
          cust_use_query_string = "noQS";
        }

        // replace \1 -like regex group with Fastly style regex group
        let location = '{"' + value.redirectURL.replace(/\\([1-9])/g, '"} + re.group.$1 + {"') + '"};';

        // cleanup `location` value
        location = location.replace(/ \+ {\"\"};$/, ';');

        // add rule footer
        cloudlet_redirect_logic += ')'.repeat(value.matches.length) + ` {
    set var.cust_location = ${location}
    set var.cust_priority = "${key}";
    set var.cust_status_code = "${status_code}";
    set var.cust_use_query_string = "${cust_use_query_string}";
  }`;
      }
    }
  }

  // complete the redirect table
  cloudlet_redirect_table += '}\n';

  cloudlet_redirect_logic += `

  declare local var.dict_result STRING;
  declare local var.dict_location STRING;
  declare local var.dict_priority STRING;
  declare local var.dict_status_code STRING;
  declare local var.dict_use_query_string STRING;

  // make a table lookup for a strict match result
  set var.dict_result = table.lookup(path_redirect, req.url.path);

  if (var.dict_result ~ "^(\\d+)\\|(\\d+)\\|(useQS|noQS)\\|(.*)") {
    set var.dict_priority = re.group.1;
    set var.dict_status_code = re.group.2;
    set var.dict_use_query_string = re.group.3;
    set var.dict_location = re.group.4;
  }

  // There can be only one of the following scenarios
  // 1) Both, a strict and a custom rules matched. in this case the lower priority number wins
  // 2) Only a custom match
  // 3) Only a strict match
  // 4) No matches

  if (var.cust_priority && var.dict_priority) {
    if (std.atoi(var.cust_priority) < std.atoi(var.dict_priority)) {
      set req.http.X-Error-Resp = if((var.cust_use_query_string=="useQS" && req.url.qs != ""), var.cust_location + "?" + req.url.qs, var.cust_location);
      set req.http.X-Response-Code = var.cust_status_code;
    } else {
      set req.http.X-Error-Resp = if((var.dict_use_query_string=="useQS" && req.url.qs != ""), var.dict_location + "?" + req.url.qs, var.dict_location);
      set req.http.X-Response-Code = var.dict_status_code;
    }
  } elsif (var.cust_priority) {
    set req.http.X-Error-Resp = if((var.cust_use_query_string=="useQS" && req.url.qs != ""), var.cust_location + "?" + req.url.qs, var.cust_location);
    set req.http.X-Response-Code = var.cust_status_code;
  } elseif (var.dict_priority) {
    set req.http.X-Error-Resp = if((var.dict_use_query_string=="useQS" && req.url.qs != ""), var.dict_location + "?" + req.url.qs, var.dict_location);
    set req.http.X-Response-Code = var.dict_status_code;
  } else {
    // no matches
    unset req.http.X-Error-Resp;
  }

  if (req.http.X-Error-Resp) {

    error 777 req.http.X-Error-Resp; // Return redirect
  }

  error 200;

`;

  // update snippets' code
  vcl_snippets.cloudlet_redirect_table.vcl = cloudlet_redirect_table.escapeSpecialChars();
  vcl_snippets.cloudlet_redirect_logic.vcl = cloudlet_redirect_logic.escapeSpecialChars();
  vcl_snippets.cloudlet_redirect_handler.vcl = cloudlet_redirect_handler.escapeSpecialChars();

  let active_ver = await get_active_service(serviceId, key);
  let cloned_ver = await clone_active_version(serviceId, key, active_ver);
  await delete_snippets(serviceId, key, cloned_ver);
  await upload_snippets(serviceId, key, cloned_ver);
  await active_version(serviceId, key, cloned_ver);

  const resp = new Response(response);

  // Construct a new response using the new data but original status.
  res.send(resp);
});

router.all("(.*)", async (req, res) => {
  let json_notfound = {
    "msg": "Bad request",
    "detail": "Route not found"
  }
  let notFoundResponse = new Response(JSON.stringify(json_notfound, null, 2).escapeSpecialChars(), {
    status: 404,
    statusText: "Not Found",
    headers: {
      "Content-Type": JsonContentType
    }
  });
  res.send(notFoundResponse);
});

router.listen();

function build_condition(match_list, matches_idx, match_operand, negate) {
  // go over all space separated values
  for (let value_idx = 0; value_idx < match_list.length; value_idx++) {
    // when wildcard characters present, the strict match has to be converted to regex
    let wildcard = /([?*])/;
    let eval_matchURL;
    let eval_operator;
    if (wildcard.test(match_list[value_idx])) {
      eval_matchURL = match_list[value_idx].replace(/([?*])/g, ".$1");
      eval_operator = negate ? "!~" : "~";
    } else {
      eval_matchURL = match_list[value_idx];
      eval_operator = negate ? "!=" : "==";
    }

    if (value_idx == 0) {
      // 2+ match rules are treated as a logical AND
      cloudlet_redirect_logic += matches_idx > 0 ? ') && (' : '';
    } else {
      // items in a space separated list are treated as logical OR
      cloudlet_redirect_logic += ` || `;
    }
    cloudlet_redirect_logic += `${match_operand} ${eval_operator} "${eval_matchURL}"`;
  }
}

async function get_active_service(sid, key) {
  let serviceURL = baseURL + sid;
  let newReq = new Request(serviceURL);

  let beresp = await fetch(newReq, {
    backend: API_BACKEND,
    headers: {
      "Fastly-Key": key
    }
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

async function clone_active_version(sid, key, ver) {
  let serviceURL = `${baseURL}${sid}/version/${ver}/clone`;
  let newReq = new Request(serviceURL);
  let beresp = await fetch(newReq, {
    backend: API_BACKEND,
    method: "PUT",
    headers: {
      "Fastly-Key": key
    }
  });
  let resp = await beresp.json();

  console.log("Active version cloned to version", resp.number);
  return resp.number;
}

async function delete_snippets(sid, key, ver) {
  // /service/service_id/version/version_id/snippet/snippet_name
  for (const snippet of Object.keys(vcl_snippets)) {
    let serviceURL = `${baseURL}${sid}/version/${ver}/snippet/${snippet}`;
    let newReq = new Request(serviceURL);
    let beresp = await fetch(newReq, {
      backend: API_BACKEND,
      method: "DELETE",
      headers: {
        "Fastly-Key": key
      }
    });
    let resp = await beresp.json();
    console.log(`Deleting snippet '${snippet}' - ${beresp.status} ${beresp.statusText}`);
  }
}

async function upload_snippets(sid, key, ver) {
  let serviceURL = `${baseURL}${sid}/version/${ver}/snippet`;
  for (const [snippet, attrs] of Object.entries(vcl_snippets)) {
    let json_snippet = {
      "name": snippet,
      "dynamic": 0,
      "type": attrs.type,
      "content": attrs.vcl.escapeSpecialChars()
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
        "Accept": JsonContentType
      }
    });
    // eslint-disable-next-line no-unused-vars
    let resp = await beresp.json();
    console.log(`Uploading  snippet '${snippet}' - ${beresp.status} ${beresp.statusText}`);
    // console.log("Uploading snippet `encoded_redirect_table` - " + JSON.stringify(resp, null, 2));
  }
}

async function active_version(sid, key, ver) {
  let serviceURL = `${baseURL}${sid}/version/${ver}/activate`;
  let newReq = new Request(serviceURL);
  let beresp = await fetch(newReq, {
    backend: API_BACKEND,
    method: "PUT",
    headers: {
      "Fastly-Key": key
    }
  });
  let resp = await beresp.json();

  console.log("Activating version", ver, "- ", JSON.stringify(resp, null, 2));
}