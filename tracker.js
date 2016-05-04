/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/**
 * Configuration
 */

var gMetabugs = {
  // "alias": bug number,
  // TODO: update this object for your needs
  //"australis-meta": 870032,
  //"australis-tabs": 732583,
  //"fx-qx": 1244854,
};
var gDefaultMetabug = null; // Example: gMetabugs["australis-meta"];

var gColumns = {
  "id": "ID",
  "status": "Status",
  "resolution": "",
  "cf_last_resolved": "Last Resolved",
  //"creator": "Reporter",
  "assigned_to": "Assignee",
  "product": "Prod.",
  "component": "Comp.",
  "summary": "Summary",
  "whiteboard": "Whiteboard",
  //"cf_fx_points": "Points",
  "cf_fx_iteration": "Iter.",
  "priority": "Pri.",
  //"milestone": "M?",
  "keywords": "Keywords",
};


const BUG_CHUNK_SIZE = 100;
const BUGZILLA_ORIGIN = "https://bugzilla.mozilla.org";
/**
 * Max dependency depth
 */
const DEFAULT_MAX_DEPTH = 4;
const VIRTUAL_COLUMNS = ["milestone"];

/**
 * State variables
 */

var gBugs = {};
var gBugsAtMaxDepth = {}; // For debugging only
var gHTTPRequestsInProgress = 0;
var gUrlParams = {};
var gFilterEls = {};
var gSortColumn = null;
var gSortDirection = null;
var gHasFlags = false;
var gLastPrintTime = 0;
/**
 * Array of depths containing bugs still to fetch which were found at that depth.
 * i.e. dependencies of the root would appear in the array at index 0.
 */
var gDependenciesToFetch = [];


/**
 * Deals with batching of bug requests by depth in order to reduce the number of requests to
 * Bugzilla while also not creating query strings which are too long.
 *
 * Instead of making three requests for two bugs each at depth N, make one request for all six bugs.
 * Instead of making one request for 200 bugs which may exceed the query string limit, split into
 * chunks of size BUG_CHUNK_SIZE.
 *
 * @param {Number} depth - depth to fetch a batch of bugs from
 */
function getDependencySubset(depth) {
  var totalDepsToFetch = gDependenciesToFetch.reduce(function(a, b) {
    return a + b.length;
  }, 0);
  var subset = gDependenciesToFetch[depth].splice(0, BUG_CHUNK_SIZE);
  setStatus(totalDepsToFetch + " dependencies queued to fetch… <progress />");
  fetchBugs(subset, depth + 1);
}

/**
 * Note: One limitation is that the max depth will affect whether additional
 * paths from the root are found.
 *
 * @param {Object} bug
 * @param {Number} [depth = undefined] - the depth this bug was first found at
 *                 or undefined if this bug wasn't just found.
 */
function hasRootPathWithoutMinus(bug, depth) {
  // If the bug itself is minused, no need to check it's ancestors.
  if (isBugMinused(bug)) {
    return false;
  }

  // Handle bugs with existing paths when we don't know they depth later.
  if (bug._rootPathWithoutMinus === true) {
    return true;
  }

  // Since the root bug isn't in gBugs we need this special case so children of
  // the root return true if they themselves aren't minused.
  if (depth === 1) {
    return true;
  }

  // Check if we found any of its parents in the tree already and it had a path
  // to the root without a minus. Note that we might not have fetched some of
  // the parents yet so this answer can change when we see the same bug later.
  return bug.blocks.some(function(blocksId) {
    return blocksId in gBugs && gBugs[blocksId]._rootPathWithoutMinus === true;
  });
}

/**
 * @param {Number} depth - Depth of the returned bugs. 0 = root bug only, 1 = dependencies of the root, etc.
 * @param {String} response - HTTP response string from the XHR.
 */
function handleBugsResponse(depth, response) {
  var json = JSON.parse(response);
  var bugs = json.bugs;
  //console.info("response:", depth, bugs);
  for (var i = 0; i < bugs.length; i++) {
    // First occurrence at the max depth
    if (depth == parseInt(gFilterEls.maxdepth.value) && !(bugs[i].id in gBugs)) {
      gBugsAtMaxDepth[bugs[i].id] = bugs[i];
    }

    // Add the found bug to the gBugs array.
    // Don't include the root bug in the array.
    if (depth > 0) {
      gBugs[bugs[i].id] = bugs[i];
      gBugs[bugs[i].id]._rootPathWithoutMinus = hasRootPathWithoutMinus(bugs[i], depth);
    }

    // Add any depedencies to the array of dependencies to fetch for the specified
    // depth unless we've already fetched that bug through a different path.
    if ("depends_on" in bugs[i] && Array.isArray(bugs[i].depends_on)) {
      for (var j = 0; j < bugs[i].depends_on.length; j++) {
        var depBugId = bugs[i].depends_on[j];
        if (depBugId in gBugs) {
          // We don't know the depth since we don't know at what depth it was found originally.
          var before = gBugs[depBugId]._rootPathWithoutMinus;
          gBugs[depBugId]._rootPathWithoutMinus = hasRootPathWithoutMinus(gBugs[depBugId], undefined);
          var after = gBugs[depBugId]._rootPathWithoutMinus;
          if (!before && after) {
            console.info("!before && after", depBugId); // TODO: test that this happens
          }
        } else {
          gDependenciesToFetch[depth].push(depBugId);
        }
      }
    }
  }

  // Kick off fetches if we're already over the chunk size for this depth.
  while (gDependenciesToFetch[depth].length >= BUG_CHUNK_SIZE) {
    getDependencySubset(depth);
  }

  window.setTimeout(printList, 0);
}

function getFilterValue(el) {
  switch (el.type) {
    case undefined:
      break;
    case "checkbox":
      return el.checked ? el.value : "0";
      break;
    default:
      return el.value;
      break;
  }
}

function hasDefaultValue(el) {
  switch (el.type) {
    case "checkbox":
      return el.checked === el.defaultChecked;
      break;
    default:
      if (el.localName == "select") {
        return el.selectedOptions[0].defaultSelected;
      } else {
        return el.value === el.defaultValue;
      }
      break;
  }
}

function buildURL() {
  var url = "";
  if (gUrlParams.list)
    url = "?list=" + encodeURIComponent(gUrlParams.list);
  Object.keys(gFilterEls).forEach(function(paramName) {
    var filterVal = getFilterValue(gFilterEls[paramName]);
    // Don't include defaults but allow 0.
    if (filterVal === null || filterVal === NaN)
      return;

    if (hasDefaultValue(gFilterEls[paramName]))
      return;

    // meta defaults to 1.
    if (paramName == "meta" && filterVal == "1")
      return;

    if (paramName == "maxdepth" && filterVal == DEFAULT_MAX_DEPTH)
      return;

    if (paramName == "resolved" && filterVal === "0")
      return;

    url += (url ? "&" : "?") + paramName + "=" + encodeURIComponent(filterVal);
  });
  ["Column", "Direction"].forEach(function(paramName) {
    var filterVal = window["gSort" + paramName];
    if (!filterVal)
      return;

    url += (url ? "&" : "?") + "sort" + paramName + "=" + encodeURIComponent(filterVal);
  });
  // if we only return an empty string, then pushState doesn't work
  return url || "?";
}

function filterChanged(evt) {
  console.log("filterChanged", evt);
  var requireNewFetch = false;
  var requireNewLoad = false;

  if (evt.target == gFilterEls.maxdepth) {
    requireNewLoad = true;
  }

  // Handle the click on the Go button to change lists
  if (evt.type == "submit") {
    requireNewLoad = true;
  }

  var showResolved = parseInt(getFilterValue(gFilterEls.resolved), 2);
  document.getElementById("list").dataset.showResolved = showResolved;

  var metaFilter = document.getElementById("showMeta");
  var mMinusFilter = document.getElementById("showMMinus");
  var assigneeFilter = document.getElementById("assigneeFilter");
  var flagFilter = document.getElementById("showFlags");

  if (!gHasFlags && gFilterEls.flags.checked) {
    requireNewFetch = true;
  }

  document.getElementById("list").dataset.product = getFilterValue(gFilterEls.product);

  if (gFilterEls.flags.checked) {
    gColumns["flags"] = "Flags";
    gColumns["attachments"] = "Attachment Flags";
  } else {
    delete gColumns["flags"];
    delete gColumns["attachments"];
  }

  window.history.pushState(gUrlParams, "", buildURL());

  if (requireNewFetch || requireNewLoad) {
    // Can't start new unrelated requests when there are others pending
    if (gHTTPRequestsInProgress || requireNewLoad) {
      window.location = buildURL();
      evt.preventDefault();
      return;
    } else {
      getBugsUnderRoot();
    }
  }

  printList(true);
}

/**
 * Fetch bugs that are descendants of the root bug at the specified depth.
 * If `depth` is greater than the max depth, no bugs will be fetched.
 *
 * If `blocks` is an array, fetch the specified bugs.
 * Otherwise, fetch bugs that block the bug number/alias (an actual alias on Bugzilla).
 *
 * @param {Number|Number[]|String} blocks - bug number, bugzilla alias, or array of bug numbers
 * @param {Number} depth - number of levels below the root bug that we are fetching
 */
function fetchBugs(blocks, depth) {
  console.log("fetchBugs:", depth, blocks);
  if (depth > parseInt(gFilterEls.maxdepth.value)) {
    console.log("max. depth reached: ", depth);
    if (!gHTTPRequestsInProgress) {
      setStatus("");
    }
    return;
  }

  var blocksParams = "";
  if (Array.isArray(blocks)) {
    blocksParams += "&id=" + blocks.join(",");
  } else {
    var bugNum = Number(blocks);
    if (bugNum) {
      blocksParams += "&id=" + encodeURIComponent(blocks);
    } else {
      blocksParams += "&alias=" + encodeURIComponent(blocks);
    }
  }

  if (gFilterEls.flags.checked) {
    gColumns["flags"] = "Flags";
    gColumns["attachments"] = "Attachment Flags";
  } else {
    delete gColumns["flags"];
    delete gColumns["attachments"];
  }

  var bzColumns = Object.keys(gColumns).filter(function(val) { // gColumns without virtual columns (e.g. milestone)
    return VIRTUAL_COLUMNS.indexOf(val) === -1;
  });

  var apiURL = BUGZILLA_ORIGIN + "/bzapi/bug" +
        "?" + blocksParams.replace(/^&/, "") +
        "&include_fields=depends_on,blocks," + bzColumns.join(",");

  var hasFlags = gFilterEls.flags.checked;
  var xhr = new XMLHttpRequest();
  var callback = handleBugsResponse.bind(this, depth);
  xhr.onreadystatechange = function progressListener() {
    if (this.readyState == 4) {
      if (this.status == 200) {
        gHasFlags = hasFlags;
        callback.call(this, this.responseText);
      } else {
        setStatus(this.statusText);
      }
    }
  };
  xhr.onloadend = function loadend() {
    xhr = null;
    gHTTPRequestsInProgress--;
    if (!gHTTPRequestsInProgress) {
      setStatus("");
      // clear out all deps. to fetch at all depths
      for (var d = 0; d < gDependenciesToFetch.length; d++) {
        while (gDependenciesToFetch[d].length) {
          getDependencySubset(d);
        }
      }
      printList(true);
    }
  };
  xhr.onerror = function xhr_error(evt) {
    setStatus("There was an error with a request: " + evt.target.statusText);
  };

  xhr.open("GET", apiURL, true);
  xhr.setRequestHeader('Accept',       'application/json');
  xhr.setRequestHeader('Content-Type', 'application/json');
  xhr.send();
  gHTTPRequestsInProgress++;
}

function isBugMinused(bug) {
  if (!bug.whiteboard) {
    return false;
  }
  return bug.whiteboard.toLowerCase().indexOf(":m-]") !== -1 ||
         bug.whiteboard.toLowerCase().indexOf(":p-]") !== -1;
}

function flagText(flag, html) {
  var text = flag.name + flag.status + (flag.requestee ? "(" + shortenUsername(flag.requestee.name) + ")" : "");
  if (html && flag.status == "?") {
    var span = document.createElement("span");
    span.className = "flag";
    span.dataset.flagName = flag.name;
    span.dataset.flagStatus = flag.status;
    span.textContent = text;
    text = span.outerHTML;
  }
  return text;
}

function shortenUsername(username) {
  return username.replace("+bmo", "").replace("+bugs", "").replace("mnoorenberghe", "MattN");
}

function printList(unthrottled) {
  var nowTime = Date.now();
  if (!unthrottled && nowTime - gLastPrintTime < 250) { // 250ms throttle
    return;
  }
  gLastPrintTime = nowTime;

  var table = document.getElementById("list");
  // Delete existing rows
  var rows = document.querySelectorAll("#list > tbody > tr");
  for (var i = 0; i < rows.length; i++) {
    var elmt = rows[i];
    elmt.parentNode.removeChild(elmt);
  }
  table.tHead.parentNode.removeChild(table.tHead);
  var thead = document.createElement("thead");
  thead.addEventListener("click", function sortListener(evt) {
    if (!("column" in evt.target.dataset))
      return;
    // delay checking to see what column is sorted until sorttable has time to work.
    setTimeout(function() {
      var sortedColumn = thead.querySelector(".sorttable_sorted, .sorttable_sorted_reverse");
      gSortColumn = sortedColumn.dataset.column;
      gSortDirection = sortedColumn.classList.contains("sorttable_sorted_reverse") ? "desc" : "asc";
      filterChanged(evt);
    }, 1000);
  });
  table.insertBefore(thead, table.tBodies[0]);
  var headerRow = document.createElement("tr");
  thead.appendChild(headerRow);
  Object.keys(gColumns).forEach(function(columnId) {
    var th = document.createElement("th");
    th.textContent = gColumns[columnId];
    th.className = columnId;
    th.dataset.column = columnId;
    headerRow.appendChild(th);
  });

  var whiteboardFilter = getFilterValue(gFilterEls.whiteboard);
  var assigneeFilter = getFilterValue(gFilterEls.assignee);
  var resolvedFilter = getFilterValue(gFilterEls.resolved);
  var productFilter = getFilterValue(gFilterEls.product);
  var metaFilter = getFilterValue(gFilterEls.meta);
  var mMinusFilter = getFilterValue(gFilterEls.mMinus);

  Object.keys(gBugs).forEach(function(bugId) {
    var bug = gBugs[bugId];
    var tr = document.createElement("tr");
    tr.id = bug.id;
    tr.classList.add(bug.status);
    // Marked bugs in project branches as fixed e.g. [fixed-in-ux] or [fixed in jamun]
    if (bug.whiteboard && bug.whiteboard.indexOf("[fixed") !== -1) {
      tr.classList.add("RESOLVED");
    }

    if (resolvedFilter !== "" && (tr.classList.contains("RESOLVED") || tr.classList.contains("VERIFIED")) != resolvedFilter) {
      return;
    }

    if (assigneeFilter !== "") {
      if (assigneeFilter == "unassigned") {
        if (!bug.assigned_to.name.startsWith("nobody"))
          return;
      } else if (assigneeFilter == "assigned") {
        if (bug.assigned_to.name.startsWith("nobody"))
          return;
      } else {
        if (shortenUsername(bug.assigned_to.name).toLowerCase() != assigneeFilter.toLowerCase())
          return;
      }
    }

    if ((productFilter && bug.product != productFilter) || bug.product == "Thunderbird" || bug.product == "Seamonkey") {
      return;
    }

    if (metaFilter === "0" && bug.keywords && bug.keywords.indexOf("meta") != -1) {
      return;
    }

    if (mMinusFilter === "0" && !bug._rootPathWithoutMinus) {
      return;
    }
    var whiteboardFilterLower = whiteboardFilter.toLowerCase();
    if (whiteboardFilter && (!(bug.whiteboard && bug.whiteboard.toLowerCase().indexOf(whiteboardFilterLower) !== -1) &&
                             !(bug.keywords && bug.keywords.join(" ").toLowerCase().indexOf(whiteboardFilterLower) !== -1))
       ) {
         return;
       }

    Object.keys(gColumns).forEach(function(column) {
      var col = document.createElement("td");
      if (column)
        col.classList.add(column);
      if (Array.isArray(bug[column])) { // Arrays
        if (column == "flags") {
          bug[column].forEach(function(flag) {
            // Ignore some old bug flags that are no longer relevant
            if (flag.name.startsWith("blocking-aviary") || flag.name.endsWith("1.9") || flag.name.endsWith("firefox2")) {
              return;
            }
            col.innerHTML += flagText(flag, true) + " ";
          });
        } else if (column == "keywords") {
          col.textContent = bug[column].join(", ");
        } else if (column == "attachments") {
          var currentAttachmentsWithFlags = bug[column].filter(function filterAttachments (att) {
            return (!att.is_obsolete && att.flags);
          });
          currentAttachmentsWithFlags.forEach(function(attachment) {
            attachment.flags.forEach(function(flag) {
              col.innerHTML += flagText(flag, true) + " ";
            });
          });
          // If there are no attachment flags, indicate if there is a non-obsolete patch.
          if (!currentAttachmentsWithFlags.length) {
            var currentPatches = bug[column].filter(function filterAttachments (att) {
              return (!att.is_obsolete && att.is_patch);
            });
            if (currentPatches.length) {
              col.textContent = "(none)";
            }
          }
        } else {
          console.log(bug[column]);
          col.textContent = "ARRAY";
        }
      } else if (typeof(bug[column]) == "object") { // Objects
        if (bug[column].name) { // e.g. User object
          var shortName = shortenUsername(bug[column].name);
          // Ignore the case of usernames and sort "nobody" last.
          col.setAttribute("sorttable_customkey", shortName.toLowerCase().replace(/^nobody/, "zzzzznobody"));
          col.textContent = shortName;
        } else {
          col.textContent = '';
        }

        col.dataset[column] = col.textContent;
      } else if (column == "id" || column == "summary") {
        var a = document.createElement("a");
        a.href = BUGZILLA_ORIGIN + "/show_bug.cgi?id=" + bug.id;
        a.textContent = bug[column];
        col.appendChild(a);
      } else if (column == "status" || column == "resolution") {
        if (typeof(bug[column]) !== "undefined")
          col.textContent = bug[column].substr(0, 4);
      } else if (column == "component") {
        col.textContent =  bug[column].replace(/and Customization/, "& Cust.");
      } else if (column == "priority") { // Custom sort order for +/-
        col.textContent =  bug[column];
        // Comma character is between + and - in ASCII
        col.setAttribute("sorttable_customkey", bug[column].replace(/^(P\d)$/, "$1,"));
      } else if (column == "whiteboard") {
        if (bug[column]) {
          var wb = bug[column];
          wb = wb.replace(/\[[^:\]]+:(P[^\]]+)\]/, function(match, priority) {
            bug["priority"] = priority;
            return "";
          });
          wb = wb.replace(/\[M[^\]]+\]/, function(match) {
            bug["milestone"] = match.slice(1, -1);
            return "";
          });
          wb = wb.replace(/(\W|^)p=(\d*)/, function(match, p1, p2) {
            // Don't overwrite the real field with the whiteboard
            if (!bug["cf_fx_points"] || bug["cf_fx_points"] == "---") {
              bug["cf_fx_points"] = p2;
            }
            return p1;
          });
          wb = wb.replace(/(\W|^)s=([^\[ ]*)/, function(match, p1, p2) {
            // Don't overwrite the real field with the whiteboard
            if (!bug["cf_fx_iteration"] || bug["cf_fx_iteration"] == "---") {
              bug["cf_fx_iteration"] = p2;
            }
            return p1;
          });
          col.textContent = wb;

          // Do this transform on the HTML so HTML can be added and so HTML is already escaped.
          col.innerHTML = col.innerHTML.replace(/\[blocked[^\]]*\]/i, "<span class=blocked>$&</span>");
        }
      } else if (column == "milestone") {
        col.textContent =  bug[column] || "--";
      } else {
        col.textContent =  bug[column];
      }
      tr.appendChild(col);
    });
    tr.dataset.priority = bug["priority"].replace(/(\d)[-+]/, "$1");
    table.tBodies[0].appendChild(tr);
  });
  sorttable.makeSortable(table);
  if (gSortColumn) {
    var sortTh = thead.querySelector("th[data-column='" + gSortColumn + "']");
    if (sortTh) {
      sorttable.innerSortFunction.apply(sortTh, []);
      // sort again if we want the other direction
      if (gSortDirection == "desc") {
        sorttable.innerSortFunction.apply(sortTh, []);
      }
    }
  }
}

function setStatus(message) {
  var statusbox = document.getElementById("status");
  if (message) {
    console.log("setStatus:", message);
    statusbox.innerHTML = message;
    statusbox.classList.remove("hidden");
  } else {
    statusbox.classList.add("hidden");
  }
}

function parseQueryParams() {
  console.log("parseQueryParams");
  var match,
      pl     = /\+/g,  // Regex for replacing addition symbol with a space
      search = /([^&=]+)=?([^&]*)/g,
      decode = function (s) { return decodeURIComponent(s.replace(pl, " ")); },
      query  = window.location.search.substring(1);

  gUrlParams = {};
  while ( (match = search.exec(query)) )
    gUrlParams[decode(match[1])] = decode(match[2]);
  loadFilterValues(gUrlParams);
};

function loadFilterValues(state) {
  console.log("loadFilterValues", state);
  var assignee = ("assignee" in state ? state.assignee : "");
  gFilterEls.assignee.value = assignee;
  if (assignee && gFilterEls.assignee.value != assignee) {
    // We set the value but it doesn't match. This means we need to add an option.
    var option = document.createElement("option");
    option.value = option.textContent = assignee;
    gFilterEls.assignee.options.add(option);
    gFilterEls.assignee.value = assignee;
  }

  gFilterEls.resolved.value = ("resolved" in state ? state.resolved : "0");
  gFilterEls.product.value = ("product" in state ? state.product : "");
  document.getElementById("list").dataset.product = gFilterEls.product.value;
  gFilterEls.meta.checked = ("meta" in state ? state.meta : "") !== "0";
  gFilterEls.mMinus.checked = ("mMinus" in state ? state.mMinus : "") === "1";
  gFilterEls.flags.checked = ("flags" in state ? state.flags : "") === "1";
  gFilterEls.whiteboard.value = ("whiteboard" in state ? state.whiteboard : "");
  gFilterEls.maxdepth.value = ("maxdepth" in state ? state.maxdepth : DEFAULT_MAX_DEPTH);
  gSortColumn = ("sortColumn" in state ? state.sortColumn : gSortColumn);
  gSortDirection = ("sortDirection" in state ? state.sortDirection : gSortDirection);
}

/**
 * This function gets called once upon DOMContentLoaded to setup static state and markup.
 * The function then kicks up the initial request for bugs.
 *
 * Nothing directly in this function should depend on URL parameters.
 */
function init() {
  var fileBugList = document.querySelector("#file > ul");
  var listbox = document.getElementById("metabugs");
  listbox.textContent = 'Metabugs: ';
  listbox.innerHTML += '<a href="./">ALL</a> ';
  Object.keys(gMetabugs).forEach(function(list){
    // TODO: don't hard-code the product. Unfortunately the blocked parameter gets lost without a product though :(
    fileBugList.innerHTML += '<li><a href="' + BUGZILLA_ORIGIN + '/enter_bug.cgi?product=Firefox&blocked=' + gMetabugs[list] + '">' + list + '</a></li>';
    document.getElementById("file").style.display = "";
    if (gMetabugs[list] == gDefaultMetabug)
      return;
    listbox.innerHTML += '<a href="?list=' + list + '">' + list + '</a> ';
    listbox.hidden = false;
  });

  gFilterEls.resolved = document.getElementById("showResolved");
  gFilterEls.product = document.getElementById("productChooser");
  gFilterEls.meta = document.getElementById("showMeta");
  gFilterEls.mMinus = document.getElementById("showMMinus");
  gFilterEls.assignee = document.getElementById("assigneeFilter");
  gFilterEls.flags = document.getElementById("showFlags");
  gFilterEls.maxdepth = document.getElementById("maxDepth");
  gFilterEls.whiteboard = document.getElementById("whiteboardFilter");

  parseQueryParams();

  if (gFilterEls.flags.checked) {
    gColumns["flags"] = "Flags";
    gColumns["attachments"] = "Attachment Flags";
  }

  // Add filter listeners after loading values
  gFilterEls.assignee.addEventListener("change", filterChanged);
  gFilterEls.resolved.addEventListener("change", filterChanged);
  gFilterEls.product.addEventListener("change", filterChanged);
  gFilterEls.meta.addEventListener("change", filterChanged);
  gFilterEls.mMinus.addEventListener("change", filterChanged);
  gFilterEls.flags.addEventListener("change", filterChanged);
  gFilterEls.maxdepth.addEventListener("input", filterChanged);
  gFilterEls.whiteboard.addEventListener("input", filterChanged);

  // Print the headings to reduce jumping when the first printList happens later.
  printList(true);

  getBugsUnderRoot();
}

/**
 * Prepare for loading the root bug (if specified) or prompt otherwise.
 *
 * This function can be called more than once on a page load
 * e.g. if flag columns are requested after the page was fully loaded without flags.
 */
function getBugsUnderRoot() {
  // Populate/clear gDependenciesToFetch for the appropriate number of levels.
  gDependenciesToFetch = new Array(parseInt(gFilterEls.maxdepth.value) + 1);
  for (var d = 0; d < gDependenciesToFetch.length; d++) {
    gDependenciesToFetch[d] = [];
  }

  // This can be an alias known only to the dashboard in gMetabugs, not only a Bugzilla alias.
  var rootBugOrAlias = gUrlParams.list || window.location.hash.replace("#", "") || gDefaultMetabug;

  var heading = document.getElementById("title");
  var treelink = document.getElementById("treelink");
  if (!rootBugOrAlias) {
    heading.removeAttribute("href");
    treelink.firstElementChild.removeAttribute("href");
    treelink.style.display = "none";

    document.getElementById("form").hidden = false;
    document.getElementById("list").hidden = true;
    document.getElementById("tools").hidden = true;
    document.getElementById("showFlagsLabel").hidden = true;
    return;
  }

  // Update the heading and title for the specified root bug.
  if (Number(rootBugOrAlias)) {
    heading.textContent = "Bug " + rootBugOrAlias;
  } else {
    heading.textContent = rootBugOrAlias;
  }
  document.title = rootBugOrAlias + " - Dependency Bug List";


  // Lookup in gMetabugs in case we have an alias known only to the dashboard, not to bugzilla.
  var bugzillaBugOrAlias = rootBugOrAlias in gMetabugs ? gMetabugs[rootBugOrAlias] : rootBugOrAlias;
  heading.href = BUGZILLA_ORIGIN + "/show_bug.cgi?id=" + bugzillaBugOrAlias;
  treelink.firstElementChild.href = BUGZILLA_ORIGIN + "/showdependencytree.cgi?id=" + bugzillaBugOrAlias +
    "&maxdepth=" + gFilterEls.maxdepth.value + "&hide_resolved=1";
  treelink.style.display = "inline";

  setStatus("Loading bugs… <progress />");
  fetchBugs(bugzillaBugOrAlias, 0);
}

document.addEventListener("DOMContentLoaded", init);
window.onpopstate = parseQueryParams;
