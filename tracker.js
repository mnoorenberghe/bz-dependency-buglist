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
  "australis-meta": 870032,
  //"australis-tabs": 732583,
};
var gDefaultMetabug = gMetabugs["australis-meta"]; // TODO: update this for your needs

var gColumns = {
  "id": "ID",
  "status": "Status",
  "resolution": "",
  //"creator": "Reporter",
  "assigned_to": "Assignee",
  "product": "Prod.",
  "component": "Comp.",
  "summary": "Summary",
  "whiteboard": "Whiteboard",
  "priority": "Pri.",
  //"milestone": "M?",
  "keywords": "Keywords",
};

// Max dependency depth
var MAX_DEPTH = 4;
var BUG_CHUNK_SIZE = 100;

/**
 * State variables
 */

var gBugs = {};
var gBugsAtMaxDepth = {};
var gVisibleBugs = {};
var gHTTPRequestsInProgress = 0;
var gUrlParams = {};
var gFilterEls = {};
var gSortColumn = null;
var gSortDirection = null;
var gHasFlags = false;
var gLastPrintTime = 0;
var gVisibleReporters = {};
var gDependenciesToFetch = []; // TODO: g prefix
for (var d = 0; d < MAX_DEPTH; d++) {
    gDependenciesToFetch[d] = [];
}

function getDependencySubset(depth) {
  var totalDepsToFetch = gDependenciesToFetch.reduce(function(a, b) {
    return a + b.length;
  }, 0);
  var subset = gDependenciesToFetch[depth].splice(0, BUG_CHUNK_SIZE);
  setStatus("Fetching " + subset.length + "/" + totalDepsToFetch + " remaining dependencies… <progress />");
  getList(subset, depth + 1);
}

function handleMetabugs(depth, response) {
  var json = JSON.parse(response);
  var bugs = json.bugs;

  for (var i = 0; i < bugs.length; i++) {
      // First occurrence at MAX_DEPTH
    if (depth == MAX_DEPTH - 1 && !(bugs[i].id in gBugs)) {
        gBugsAtMaxDepth[bugs[i].id] = bugs[i];
    }
    gBugs[bugs[i].id] = bugs[i];
    if ("depends_on" in bugs[i] && Array.isArray(bugs[i].depends_on)) {
        gDependenciesToFetch[depth] = gDependenciesToFetch[depth].concat(bugs[i].depends_on.filter(function removeExisting(bugId) {
                    return !(bugId in gBugs);
                }));
        while (gDependenciesToFetch[depth].length >= BUG_CHUNK_SIZE) {
          getDependencySubset(depth);
        }
    }
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
        return el.selectedIndex == 0;
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
    if (filterVal === "" || filterVal === null || filterVal === NaN)
      return;
    // meta defaults to 1.
    if (paramName == "meta" && filterVal == "1")
      return;
    url += (url ? "&" : "?") + paramName + "=" + encodeURIComponent(filterVal);
  });
  // if we only return an empty string, then pushState doesn't work
  return url || "?";
}

function filterChanged() {
  console.log("filterChanged");
  var showResolved = parseInt(getFilterValue(gFilterEls.resolved), 2);
  window.localStorage.showResolved = showResolved;

  var metaFilter = document.getElementById("showMeta");
  window.localStorage.showMeta = getFilterValue(metaFilter);

  var mMinusFilter = document.getElementById("showMMinus");
  window.localStorage.showMMinus = getFilterValue(mMinusFilter);

  var flagFilter = document.getElementById("showFlags");
  window.localStorage.showFlags = getFilterValue(flagFilter);

  window.localStorage.product = getFilterValue(gFilterEls.product);
  document.getElementById("list").dataset.product = window.localStorage.product;

  if (gFilterEls.flags.checked) {
      gColumns["flags"] = "Flags";
      gColumns["attachments"] = "Attachment Flags";
  } else {
      delete gColumns["flags"];
      delete gColumns["attachments"];
  }

  history.pushState(gUrlParams, "", buildURL());

  if (!gHasFlags && gFilterEls.flags.checked) {
      // Can't start new unrelated requests there are others pending
    if (gHTTPRequestsInProgress) {
        window.location = buildURL();
    } else {
      loadBugs();
    }
  }

  printList(true);
}

function getList(blocks, depth) {
  //  console.log("getList:", depth, blocks);
  if (depth >= MAX_DEPTH) {
    console.log("MAX_DEPTH reached: ", depth);
    if (!gHTTPRequestsInProgress) {
      setStatus("");
    }
    return;
  }

  var blocksParams = "";
  if (!blocks) {
      /*
      // used to use the list of meta bugs but now we just do a true tree from the top so the dep. tree numbers match BZ
    Object.keys(gMetabugs).forEach(function(list) {
      blocksParams += "&blocks=" + gMetabugs[list];
      });*/
    blocksParams += "&blocks=" + gDefaultMetabug;
  } else if (Array.isArray(blocks)) {
    blocksParams += "&id=" + blocks.join(",");
  } else if (!(blocks in gMetabugs)) {
    Object.keys(gMetabugs).forEach(function(list) {
      if (list.contains(blocks))
        blocksParams += "&blocks=" + gMetabugs[list];
    });
  } else {
    blocksParams = "blocks=" + gMetabugs[blocks];
  }

  if (!Array.isArray(blocks)) { // Don't update the title for subqueries
    var heading = document.getElementById("title");
    heading.textContent = (blocks ? blocks : "Bugzilla Dependency Bug List");
    document.title = "Bugzilla Dependency Bug List" + (blocks ? " - " + blocks : "");

    var treelink = document.getElementById("treelink");
    if (gMetabugs[blocks] || !blocks) {
        var bugNum = (blocks ? gMetabugs[blocks] : gDefaultMetabug);
      heading.href = "https://bugzilla.mozilla.org/show_bug.cgi?id=" + bugNum;
      treelink.firstElementChild.href = "https://bugzilla.mozilla.org/showdependencytree.cgi?id=" + bugNum + "&maxdepth=" + MAX_DEPTH + "&hide_resolved=1";
      treelink.style.display = "inline";
    } else {
      heading.removeAttribute("href");
      treelink.firstElementChild.removeAttribute("href");
      treelink.style.display = "none";
    }
  }

  if (gFilterEls.flags.checked) {
      gColumns["flags"] = "Flags";
      gColumns["attachments"] = "Attachment Flags";
  } else {
      delete gColumns["flags"];
      delete gColumns["attachments"];
  }

  var bzColumns = Object.keys(gColumns).filter(function(val){ return val != "milestone"; }); // milestone is a virtual column.
  //console.log(bzColumns);
  var apiURL = "https://api-dev.bugzilla.mozilla.org/latest/bug" +
      "?" + blocksParams.replace(/^&/, "") +
    "&include_fields=depends_on," + bzColumns.join(",");

  var hasFlags = gFilterEls.flags.checked;
  var gHTTPRequest = null;  // TODO
  if (gHTTPRequest)
    gHTTPRequest.abort();
  gHTTPRequest = new XMLHttpRequest();
  //var callback = function(resp) { handleMetabugs(depth, resp); };
  var callback = handleMetabugs.bind(this, depth);
  gHTTPRequest.onreadystatechange = function progressListener() {
    if (this.readyState == 4) {
      if (this.status == 200) {
        gHasFlags = hasFlags;
        callback.call(this, this.responseText);
      } else {
        setStatus(this.statusText);
      }
    }
  };
  gHTTPRequest.onloadend = function loadend() {
    gHTTPRequest = null;
    gHTTPRequestsInProgress--;
    if (!gHTTPRequestsInProgress) {
        // clear out all deps. to fetch at all depths
      for (var d = 0; d < gDependenciesToFetch.length; d++) {
        while (gDependenciesToFetch[d].length) {
          getDependencySubset(d);
        }
      }
      setStatus("");
      printList(true);
    }
  };
  gHTTPRequest.onerror = function xhr_error(evt) {
    setStatus("There was an error with a request: " + evt.target.statusText);
    gHTTPRequest = null;
  };

  gHTTPRequest.open("GET", apiURL, true);
  gHTTPRequest.setRequestHeader('Accept',       'application/json');
  gHTTPRequest.setRequestHeader('Content-Type', 'application/json');
  gHTTPRequest.send();
  gHTTPRequestsInProgress++;
}

function flagText(flag) {
  return flag.name + flag.status + (flag.requestee ? "(" + shortenUsername(flag.requestee.name) + ")" : "");
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
  table.style.visibility = "";
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
      window.localStorage.sortColumn = gSortColumn;
      gSortDirection = sortedColumn.classList.contains("sorttable_sorted_reverse") ? "desc" : "asc";
      window.localStorage.sortDirection = gSortDirection;
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
  // support searching for milestones with the shortened displayed text of "[MX]"
  whiteboardFilter = whiteboardFilter.replace(/^\[m/i, "[Australis:M");
  whiteboardFilter = whiteboardFilter.replace(/^\[p/i, "[Australis:P");

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
    if (bug.whiteboard && bug.whiteboard.contains("[fixed")) {
      tr.classList.add("RESOLVED");
    }

    if (resolvedFilter !== "" && (tr.classList.contains("RESOLVED") || tr.classList.contains("VERIFIED")) != resolvedFilter) {
      return;
    }

    if ((productFilter && bug.product != productFilter) || bug.product == "Thunderbird" || bug.product == "Seamonkey") {
      return;
    }

    if (metaFilter === "0" && bug.keywords && bug.keywords.indexOf("meta") != -1) {
      return;
    }

    if (mMinusFilter === "0" && (bug.whiteboard && (bug.whiteboard.toLowerCase().contains(":m-]") || bug.whiteboard.toLowerCase().contains(":p-]")))) {
      return;
    }
    var whiteboardFilterLower = whiteboardFilter.toLowerCase();
    if (whiteboardFilter && (!(bug.whiteboard && bug.whiteboard.toLowerCase().contains(whiteboardFilterLower)) &&
                             !(bug.keywords && bug.keywords.join(" ").toLowerCase().contains(whiteboardFilterLower)))
        ) {
      return;
    }
    if (bug["creator"]) {
      if (!gVisibleReporters[bug["creator"].name]) {
          gVisibleReporters[bug["creator"].name] = {};
      }
      gVisibleReporters[bug["creator"].name][bugId] = 1;
    }

    // Note that this doesn't get cleared so really means bugs visible based on initial filters. It's only used for gathering data in the console.
    gVisibleBugs[bugId] = bug;

    Object.keys(gColumns).forEach(function(column) {
      var col = document.createElement("td");
      if (column)
        col.classList.add(column);
      if (Array.isArray(bug[column])) { // Arrays
        if (column == "flags") {
          bug[column].forEach(function(flag) {
            col.textContent += flagText(flag) + " ";
          });
        } else if (column == "keywords") {
          col.textContent = bug[column].join(", ");
        } else if (column == "attachments") {
          var currentAttachmentsWithFlags = bug[column].filter(function filterAttachments (att) {
            return (!att.is_obsolete && att.flags);
          });
          currentAttachmentsWithFlags.forEach(function(attachment) {
            attachment.flags.forEach(function(flag) {
              col.textContent += flagText(flag) + " ";
            });
          });
          // If there are no attachment flags, indicate if there is a non-obsolete patch.
          if (!currentAttachmentsWithFlags.length) {
              console.log(bug[column]);
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
        col.textContent =  (bug[column].name ? shortenUsername(bug[column].name) : '');
        col.dataset[column] = col.textContent;
      } else if (column == "id" || column == "summary") {
        var a = document.createElement("a");
        a.href = "https://bugzilla.mozilla.org/show_bug.cgi?id=" + bug.id;
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
          var wb = bug[column].replace("[Australis:M", "[M");
          wb = wb.replace("[Australis:P", "[P");
          wb = wb.replace(/\[P[^\]]+\]/, function(match) {
            bug["priority"] = match.slice(1, -1);
            return "";
          });
          wb = wb.replace(/\[M[^\]]+\]/, function(match) {
            bug["milestone"] = match.slice(1, -1);
            return "";
          });
          col.textContent = wb;
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
    var sortTh = thead.querySelector("th[data-column='" + gSortColumn + "']")
        sorttable.innerSortFunction.apply(sortTh, []);
    // sort again if we want the other direction
    if (gSortDirection == "desc") {
        sorttable.innerSortFunction.apply(sortTh, []);
    }
  }
  table.style.visibility = "visible";
}

function setStatus(message) {
  var statusbox = document.getElementById("status");
  if (message) {
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
  printList(true);
};

function loadFilterValues(state) {
  console.log("loadFilterValues", state);
  gFilterEls.resolved.value = ("resolved" in state ? state.resolved : window.localStorage.showResolved);
  gFilterEls.product.value = ("product" in state ? state.product : window.localStorage.product);
  document.getElementById("list").dataset.product = gFilterEls.product.value;
  gFilterEls.meta.checked = ("meta" in state ? state.meta : window.localStorage.showMeta) !== "0";
  gFilterEls.mMinus.checked = ("mMinus" in state ? state.mMinus : window.localStorage.showMMinus) !== "0";
  gFilterEls.flags.checked = ("flags" in state ? state.flags : window.localStorage.showFlags) === "1";
  gFilterEls.whiteboard.value = ("whiteboard" in state ? state.whiteboard : "");
  gSortColumn = ("sort" in state ? state.sort : window.localStorage.sortColumn);
  gSortDirection = ("sortDir" in state ? state.sortDir : window.localStorage.sortDirection);
}

function start() {
  var listbox = document.getElementById("metabugs");
  listbox.textContent = 'Metabugs: ';
  listbox.innerHTML += '<a href="./">ALL</a> ';
  listbox.innerHTML += '<a href="?list=tabs">ALL TABS</a> ';
  listbox.innerHTML += '<a href="?list=customization">ALL CUSTOMIZATION</a> | ';
  Object.keys(gMetabugs).forEach(function(list){
    listbox.innerHTML += '<a href="?list=' + list + '">' + list + '</a> ';
  });

  gFilterEls.resolved = document.getElementById("showResolved");
  gFilterEls.product = document.getElementById("productChooser");
  gFilterEls.meta = document.getElementById("showMeta");
  gFilterEls.mMinus = document.getElementById("showMMinus");
  gFilterEls.flags = document.getElementById("showFlags");
  gFilterEls.whiteboard = document.getElementById("whiteboardFilter");

  parseQueryParams();

  if (window.localStorage.showFlags === "1") {
      gColumns["flags"] = "Flags";
      gColumns["attachments"] = "Attachment Flags";
  }

  // Add filter listeners after loading values
  gFilterEls.resolved.addEventListener("change", filterChanged);
  gFilterEls.product.addEventListener("change", filterChanged);
  gFilterEls.meta.addEventListener("change", filterChanged);
  gFilterEls.mMinus.addEventListener("change", filterChanged);
  gFilterEls.flags.addEventListener("change", filterChanged);
  gFilterEls.whiteboard.addEventListener("input", filterChanged);

  loadBugs();
}

function loadBugs() {
  setStatus("Loading bugs… <progress />");
  getList(gUrlParams.list || window.location.hash.replace("#", ""), 0);
}

document.addEventListener("DOMContentLoaded", start);
window.onpopstate = parseQueryParams;
