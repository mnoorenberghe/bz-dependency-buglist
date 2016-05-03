Bugzilla Dependency Bug List
=====================

Flatten a dependency tree into a sortable list of bugs.

* Unresolved bugs blocking resolved bugs are included which is useful when you want to track follow-up work. Bugzilla doesn't support showing resolved under unresolved without also showing the resolved ancestors so that's the main advantages of this dashboard.
* A whiteboard tag of [myproject:P-] indicates that the bug and it's descendants shouldn't be shown.
* The dashboard also supports extracting milestones from the whiteboard e.g. [myproject:M3] for milestone 3. M- will hide a bug and its descendants from the list.

Example at https://mnoorenberghe.github.io/bz-dependency-buglist/
