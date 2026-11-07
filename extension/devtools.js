chrome.devtools.panels.create('3D Inspector', '', 'panel.html');
chrome.devtools.panels.elements.createSidebarPane('3D Inspector', (pane) => pane.setPage('sidebar.html'));
