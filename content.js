// Gemini History Cleaner Content Script

let isRunning = false;
let stopRequested = false;
let currentProgress = 0;
let totalToClean = 0;
let lastDeletedHref = null;
let lastDeletedText = null;

// Sleep utility
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Logger utility
const log = (msg, type = 'info') => {
  const logContainer = document.querySelector('.gemini-cleaner-logs');
  if (!logContainer) return;
  const item = document.createElement('div');
  item.className = `gemini-cleaner-log-item ${type}`;
  const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  item.innerText = `[${time}] ${msg}`;
  logContainer.appendChild(item);
  logContainer.scrollTop = logContainer.scrollHeight;
};

// Debug function to trace DOM structure if chats are not found
const debugDOM = () => {
  log('--- BẮT ĐẦU DEBUG DOM ---', 'warning');
  
  try {
    // 1. Log URL details
    log(`URL hiện tại: ${window.location.href}`, 'info');
    
    // 2. Log all links on the page (up to 15) to see their hrefs
    const allLinks = Array.from(document.querySelectorAll('a'));
    log(`Tổng số thẻ <a> trên trang: ${allLinks.length}`, 'info');
    
    const chatLinks = allLinks.filter(a => {
      const href = a.getAttribute('href') || '';
      return href.includes('chat') || href.includes('app') || href.includes('conversation');
    });
    log(`Số thẻ <a> có từ khóa "chat", "app", "conversation": ${chatLinks.length}`, 'info');
    
    chatLinks.slice(0, 15).forEach((link, idx) => {
      log(`Link [${idx}]: href="${link.getAttribute('href')}" text="${link.innerText.trim().replace(/\n/g, ' ').substring(0, 30)}" class="${link.className}"`, 'info');
    });
    
    // 3. Log navigation containers
    const navs = Array.from(document.querySelectorAll('nav, [role="navigation"], .recent-chats, gmat-recent-chats-list, mat-drawer, .sidebar, aside'));
    log(`Số container thanh bên (nav/drawer/sidebar): ${navs.length}`, 'info');
    navs.forEach((nav, idx) => {
      log(`Container [${idx}]: tag="${nav.tagName}" class="${nav.className}" role="${nav.getAttribute('role') || 'null'}"`, 'info');
      const childButtons = nav.querySelectorAll('button, a');
      log(`  -> Số nút/link con bên trong: ${childButtons.length}`, 'info');
    });

    // 4. Log visible buttons
    const buttons = Array.from(document.querySelectorAll('button'));
    log(`Tổng số thẻ <button> trên trang: ${buttons.length}`, 'info');
    const menuOrSidebarBtns = buttons.filter(btn => {
      const label = (btn.getAttribute('aria-label') || '').toLowerCase();
      const text = btn.innerText.toLowerCase();
      return label.includes('menu') || label.includes('sidebar') || label.includes('thanh bên') || text.includes('menu') || text.includes('gần đây');
    });
    menuOrSidebarBtns.slice(0, 5).forEach((btn, idx) => {
      log(`Button [${idx}]: text="${btn.innerText.trim()}" aria-label="${btn.getAttribute('aria-label')}" class="${btn.className}"`, 'info');
    });
  } catch (e) {
    log(`Lỗi khi debug DOM: ${e.message}`, 'error');
  }
  
  log('--- KẾT THÚC DEBUG DOM ---', 'warning');
};
// Logs display is now toggled via UI

// Robust selector to find recent conversation links
const getConversationItems = () => {
  let links = Array.from(document.querySelectorAll('a'));
  
  links = links.filter(link => {
    const href = link.getAttribute('href') || '';
    
    // 1. Must be same origin (relative path or starting with gemini.google.com)
    if (href.startsWith('http') && !href.startsWith(window.location.origin) && !href.includes('gemini.google.com')) {
      return false;
    }
    
    // 2. Check if URL contains "/app/" or starting with "/app" (e.g. /app/a98a2e...)
    // This supports multi-login links like /u/0/app/a98a2e...
    const appIndex = href.indexOf('/app/');
    if (appIndex === -1) {
      if (href.startsWith('/app/')) return true;
      return false;
    }
    
    // 3. Exclude links where "/app/" is part of a query parameter (e.g. SignOutOptions?continue=.../app/...)
    const queryIndex = href.indexOf('?');
    if (queryIndex !== -1 && appIndex > queryIndex) {
      return false;
    }
    
    const subPath = href.substring(appIndex + 5); // String after "/app/"
    
    // Exclude general pages
    const exclusions = ['activity', 'help', 'settings', 'faq', 'info', 'privacy', 'tos', 'sharing'];
    if (exclusions.some(exc => subPath.startsWith(exc) || subPath === exc)) {
      return false;
    }
    
    // Exclude the home /app path (empty subPath)
    if (subPath.trim() === '') {
      return false;
    }
    
    // If it's a subpath containing "chat/", check length after "chat/"
    if (subPath.startsWith('chat/')) {
      const chatSub = subPath.substring(5);
      return chatSub.trim().length > 2;
    }
    
    // For general IDs like /app/a98a2e2448b3686d, length must be greater than 4 characters
    return subPath.trim().length > 4;
  });
  
  return links;
};

// Find the scroll container of the sidebar
const getScrollContainer = (item) => {
  if (!item) return null;
  let parent = item.parentElement;
  while (parent && parent !== document.body) {
    const overflowY = window.getComputedStyle(parent).overflowY;
    if (overflowY === 'auto' || overflowY === 'scroll' || parent.scrollHeight > parent.clientHeight) {
      return parent;
    }
    parent = parent.parentElement;
  }
  return null;
};

// Check and expand sidebar if it's collapsed
const ensureSidebarExpanded = async () => {
  let items = getConversationItems();
  if (items.length > 0) return true;
  
  log('Không tìm thấy cuộc trò chuyện nào. Thử mở rộng thanh bên...', 'info');
  
  // Find menu button
  const buttons = Array.from(document.querySelectorAll('button'));
  let toggleBtn = buttons.find(btn => {
    const label = (btn.getAttribute('aria-label') || '').toLowerCase();
    const title = (btn.getAttribute('title') || '').toLowerCase();
    const iconText = btn.querySelector('mat-icon')?.innerText.toLowerCase() || '';
    return label.includes('menu') || label.includes('navigation') || label.includes('thanh bên') ||
           title.includes('menu') || title.includes('navigation') || title.includes('thanh bên') ||
           label.includes('expand') || title.includes('expand') || iconText.includes('menu');
  });
  
  // Fallback: search for elements with class containing 'menu' or 'drawer'
  if (!toggleBtn) {
    toggleBtn = document.querySelector('.menu-button, button.mat-icon-button, [aria-label="Main menu"], [aria-label="Menu chính"]');
  }
  
  if (toggleBtn) {
    log('Đã tìm thấy nút mở thanh bên. Đang click...', 'info');
    toggleBtn.click();
    await sleep(800); // Wait for sliding animation
    items = getConversationItems();
    if (items.length > 0) {
      log('Đã mở thanh bên thành công.', 'success');
      return true;
    }
  } else {
    log('Không tìm thấy nút menu để mở rộng thanh bên.', 'warning');
  }
  return false;
};

// Auto-scroll the sidebar container repeatedly to trigger lazy loading of all history items
const autoScrollSidebarToBottom = async () => {
  const items = getConversationItems();
  if (items.length === 0) return;
  
  log('Đang cuộn tự động để tải toàn bộ lịch sử...', 'info');
  
  let lastCount = items.length;
  let noChangeCount = 0;
  
  // Helper to scroll all scrollable ancestors of the first item to their absolute bottoms
  const scrollAllAncestors = () => {
    let parent = items[0].parentElement;
    while (parent && parent !== document.body) {
      const style = window.getComputedStyle(parent);
      const overflowY = style.overflowY || style.overflow || '';
      
      // If the container is scrollable, scroll it to the bottom
      if (overflowY === 'auto' || overflowY === 'scroll' || 
          parent.scrollHeight > parent.clientHeight || 
          parent.className.includes('scroll') || 
          parent.className.includes('sidenav')) {
        parent.scrollTop = parent.scrollHeight;
      }
      parent = parent.parentElement;
    }
  };
  
  // Helper to scroll all ancestors back to the top
  const scrollAllAncestorsToTop = () => {
    let parent = items[0].parentElement;
    while (parent && parent !== document.body) {
      const style = window.getComputedStyle(parent);
      const overflowY = style.overflowY || style.overflow || '';
      if (overflowY === 'auto' || overflowY === 'scroll' || parent.scrollHeight > parent.clientHeight) {
        parent.scrollTop = 0;
      }
      parent = parent.parentElement;
    }
  };
  
  // Max 60 scrolls to prevent infinite loops, but completely covers general use
  for (let i = 0; i < 60; i++) {
    scrollAllAncestors();
    
    // Initial wait for the dynamic API/rendering
    await sleep(650);
    
    let currentItems = getConversationItems();
    let currentCount = currentItems.length;
    
    // If count didn't increase, wait an extra 850ms as a retry in case of slow network/API response
    if (currentCount === lastCount) {
      await sleep(850);
      currentItems = getConversationItems();
      currentCount = currentItems.length;
    }
    
    // Update count dynamically in UI
    const countVal = document.getElementById('gemini-cleaner-count-val');
    if (countVal) {
      countVal.innerText = currentCount;
    }
    
    // Check if new items loaded after retry
    if (currentCount === lastCount) {
      noChangeCount++;
      // If count doesn't change after 3 consecutive attempts (including retries), we've hit the end
      if (noChangeCount >= 3) {
        log('Đã cuộn đến cuối danh sách lịch sử.', 'info');
        break;
      }
    } else {
      noChangeCount = 0;
      lastCount = currentCount;
      log(`Đang tải thêm... (Đã quét: ${currentCount} cuộc trò chuyện)`, 'info');
    }
  }
  
  scrollAllAncestorsToTop();
  await sleep(250);
};

// Scan chats and update UI
const scanConversations = async () => {
  log('Bắt đầu quét danh sách cuộc trò chuyện...', 'info');
  
  const expanded = await ensureSidebarExpanded();
  if (!expanded) {
    log('Không tìm thấy cuộc trò chuyện nào. Hãy mở rộng thanh bên thủ công.', 'warning');
    return;
  }
  
  // Disable scan button during scanning to prevent overlapping scans
  const scanBtn = document.getElementById('gemini-cleaner-scan-btn');
  if (scanBtn) {
    scanBtn.disabled = true;
    scanBtn.innerText = '⏳ Đang quét & cuộn...';
  }
  
  try {
    // Perform auto-scrolling to trigger lazy loading
    await autoScrollSidebarToBottom();
    
    const items = getConversationItems();
    const countVal = document.getElementById('gemini-cleaner-count-val');
    if (countVal) {
      countVal.innerText = items.length;
    }
    
    if (items.length > 0) {
      log(`Quét hoàn tất! Tìm thấy tổng cộng ${items.length} cuộc trò chuyện.`, 'success');
    } else {
      log('Không tìm thấy cuộc trò chuyện nào. Đã chạy debug.', 'warning');
      debugDOM();
    }
  } catch (err) {
    log(`Lỗi khi quét: ${err.message}`, 'error');
  } finally {
    if (scanBtn) {
      scanBtn.disabled = false;
      scanBtn.innerText = '🔍 Quét danh sách chat';
    }
  }
};

// Find the 3-dots option button inside a conversation item, searching its host component (gem-nav-list-item)
const findMenuButton = (item) => {
  // The host component of the conversation list item is gem-nav-list-item
  const host = item.closest('gem-nav-list-item') || item.parentElement || item;
  
  // Strategy 1: Look for button with popup menu attributes inside host
  let btn = host.querySelector('button[aria-haspopup="menu"], button[aria-haspopup="true"], button[aria-expanded], [data-test-id="conversation-menu-button"]');
  if (btn) return btn;
  
  // Strategy 2: Look for buttons containing "more", "options", "tùy chọn" in labels/class names
  const buttons = Array.from(host.querySelectorAll('button'));
  btn = buttons.find(b => {
    const label = (b.getAttribute('aria-label') || '').toLowerCase();
    const cls = b.className.toLowerCase();
    const id = b.id.toLowerCase();
    return label.includes('more') || label.includes('options') || label.includes('tùy chọn') || label.includes('menu') ||
           cls.includes('menu') || cls.includes('trigger') || cls.includes('more') || id.includes('menu');
  });
  if (btn) return btn;
  
  // Strategy 3: Look for mat-icon or text content "more_vert"
  const matIcon = host.querySelector('mat-icon');
  if (matIcon && (matIcon.innerText.includes('more_vert') || matIcon.textContent.includes('more_vert'))) {
    const parentButton = matIcon.closest('button');
    if (parentButton) return parentButton;
  }
  
  // Strategy 4: Fallback to last button inside host
  if (buttons.length > 0) {
    return buttons[buttons.length - 1];
  }
  
  return null;
};

// Find open menu panel
const getMenuPanel = () => {
  return document.querySelector('.mat-mdc-menu-panel, .mat-menu-panel, [role="menu"], .cdk-overlay-pane [role="menu"]');
};

// Find Delete option in open menu
const findDeleteMenuItem = (menuPanel) => {
  const items = Array.from(menuPanel.querySelectorAll('button, [role="menuitem"], .mat-mdc-menu-item, .mat-menu-item'));
  
  // Try finding by text translation
  const deleteItem = items.find(el => {
    const text = el.innerText.trim().toLowerCase();
    return text === 'xóa' || text === 'xoá' || text === 'delete' ||
           text.includes('xóa') || text.includes('xoá') || text.includes('delete') ||
           text.includes('remove');
  });
  
  if (deleteItem) return deleteItem;
  
  // Fallback checking for icons
  const icon = menuPanel.querySelector('mat-icon[string*="delete"], mat-icon[string*="trash"], svg[class*="delete"]');
  if (icon) {
    const parentItem = icon.closest('button, [role="menuitem"]');
    if (parentItem) return parentItem;
  }
  
  return null;
};

// Find open dialog container
const getDialog = () => {
  return document.querySelector('mat-dialog-container, .mat-mdc-dialog-container, [role="dialog"], .mat-dialog-content');
};

// Find the confirmation "Delete" button inside dialog
const findConfirmDeleteButton = (dialog) => {
  const buttons = Array.from(dialog.querySelectorAll('button'));
  
  // 1. Search exact text
  let btn = buttons.find(b => {
    const text = b.innerText.trim().toLowerCase();
    return text === 'xóa' || text === 'xoá' || text === 'delete';
  });
  if (btn) return btn;
  
  // 2. Search containment without cancel words
  btn = buttons.find(b => {
    const text = b.innerText.trim().toLowerCase();
    const isCancel = text.includes('hủy') || text.includes('huy') || text.includes('cancel') || text.includes('đóng') || text.includes('close');
    return (text.includes('xóa') || text.includes('xoá') || text.includes('delete')) && !isCancel;
  });
  if (btn) return btn;
  
  // 3. Fallback: style indication (dangerous buttons)
  btn = buttons.find(b => {
    const cls = b.className.toLowerCase();
    return cls.includes('danger') || cls.includes('warn') || cls.includes('primary') || cls.includes('confirm');
  });
  if (btn) return btn;
  
  // 4. Final fallback: last button
  if (buttons.length > 0) {
    return buttons[buttons.length - 1];
  }
  
  return null;
};

// Core deletion logic for one item
const deleteOneConversation = async (itemIndex) => {
  const items = getConversationItems();
  if (items.length <= itemIndex) {
    log('Không tìm thấy cuộc trò chuyện để xóa.', 'warning');
    return false;
  }
  
  const item = items[itemIndex];
  const currentHref = item.getAttribute('href');
  const currentText = item.innerText.trim();
  
  // Check if we are still looking at the last deleted item (wait for DOM list update)
  if (lastDeletedHref && (currentHref === lastDeletedHref || currentText === lastDeletedText)) {
    log('Đang đợi danh sách cập nhật...', 'info');
    let updated = false;
    for (let attempt = 0; attempt < 15; attempt++) {
      await sleep(150);
      const freshItems = getConversationItems();
      if (freshItems.length === 0 || 
          freshItems[0].getAttribute('href') !== lastDeletedHref || 
          freshItems[0].innerText.trim() !== lastDeletedText) {
        updated = true;
        break;
      }
    }
    if (!updated) {
      log('Tiếp tục với cuộc trò chuyện hiện tại...', 'info');
    }
  }
  
  // Re-fetch item after potential wait
  const freshItems = getConversationItems();
  const targetItem = freshItems[itemIndex] || freshItems[0];
  if (!targetItem) {
    log('Không lấy được cuộc trò chuyện sau khi cập nhật.', 'warning');
    return false;
  }
  
  const targetHref = targetItem.getAttribute('href');
  const targetText = targetItem.innerText.trim().replace(/\n/g, ' ').substring(0, 30);
  
  log(`Chuẩn bị xóa: "${targetText}..."`, 'info');
  
  // Scroll and Hover the host component (gem-nav-list-item) to trigger menu button rendering/visibility
  const hostItem = targetItem.closest('gem-nav-list-item') || targetItem.parentElement || targetItem;
  hostItem.scrollIntoView({ block: 'center' });
  
  // Dispatch hover events on both the host container and the link
  hostItem.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
  hostItem.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  targetItem.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
  targetItem.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  
  await sleep(350); // Wait for potential angular rendering/hover updates
  
  // Find menu button
  const menuBtn = findMenuButton(targetItem);
  if (!menuBtn) {
    log('Lỗi: Không tìm thấy nút 3 chấm.', 'error');
    // Log the HTML structure of the item and its parent to help diagnose the exact selector
    log('DEBUG ITEM HTML: ' + targetItem.outerHTML.substring(0, 300), 'warning');
    if (targetItem.parentElement) {
      log('DEBUG PARENT HTML: ' + targetItem.parentElement.outerHTML.substring(0, 500), 'warning');
    }
    return false;
  }
  
  // Open menu
  menuBtn.click();
  
  // Wait for menu
  let menuPanel = null;
  for (let attempt = 0; attempt < 15; attempt++) {
    await sleep(100);
    menuPanel = getMenuPanel();
    if (menuPanel) break;
  }
  
  if (!menuPanel) {
    log('Lỗi: Không mở được menu tùy chọn.', 'error');
    // Try simulated click on the button container as fallback
    menuBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await sleep(300);
    menuPanel = getMenuPanel();
    if (!menuPanel) return false;
  }
  
  // Find delete button in menu
  const deleteBtn = findDeleteMenuItem(menuPanel);
  if (!deleteBtn) {
    log('Lỗi: Không tìm thấy nút Xóa trong menu.', 'error');
    document.body.click(); // Close menu
    return false;
  }
  
  // Click delete
  deleteBtn.click();
  
  // Wait for dialog
  let dialog = null;
  for (let attempt = 0; attempt < 15; attempt++) {
    await sleep(100);
    dialog = getDialog();
    if (dialog) break;
  }
  
  if (!dialog) {
    log('Lỗi: Không hiển thị hộp thoại xác nhận.', 'error');
    return false;
  }
  
  // Find confirmation button
  const confirmBtn = findConfirmDeleteButton(dialog);
  if (!confirmBtn) {
    log('Lỗi: Không tìm thấy nút xác nhận Xóa trong hộp thoại.', 'error');
    const cancel = dialog.querySelector('button');
    if (cancel) cancel.click();
    return false;
  }
  
  // Confirm deletion
  confirmBtn.click();
  log('Đã click Xác nhận Xóa. Đang hoàn tất...', 'info');
  
  // Wait for dialog to dismiss
  for (let attempt = 0; attempt < 15; attempt++) {
    await sleep(100);
    dialog = getDialog();
    if (!dialog) break;
  }
  
  lastDeletedHref = targetHref;
  lastDeletedText = targetItem.innerText.trim();
  
  log('Xóa thành công!', 'success');
  await sleep(450); // Cooldown for UI update
  return true;
};

// Bulk delete loop
const deleteBulk = async (count) => {
  isRunning = true;
  stopRequested = false;
  currentProgress = 0;
  totalToClean = count;
  
  updateUIState();
  log(`Bắt đầu tiến trình xóa ${count} cuộc trò chuyện...`, 'warning');
  
  for (let i = 0; i < count; i++) {
    if (stopRequested) {
      log('Đã dừng tiến trình xóa theo yêu cầu.', 'warning');
      break;
    }
    
    updateProgressBar(i, count);
    
    // We always delete index 0 (top-most) because the list shifts up.
    const success = await deleteOneConversation(0);
    if (!success) {
      log(`Tiến trình bị gián đoạn tại bước thứ ${i + 1}/${count}.`, 'error');
      break;
    }
    
    currentProgress = i + 1;
    updateProgressBar(currentProgress, count);
  }
  
  isRunning = false;
  updateUIState();
  log(`Hoàn thành! Đã xóa thành công ${currentProgress}/${count} cuộc trò chuyện.`, 'success');
  scanConversations();
};

// UI state and progress management
const startDeletionProcess = async (count) => {
  if (isRunning) return;
  
  const expanded = await ensureSidebarExpanded();
  if (!expanded) {
    log('Vui lòng mở rộng thanh bên thủ công để tiếp tục.', 'warning');
    return;
  }
  
  const items = getConversationItems();
  if (items.length === 0) {
    log('Không tìm thấy cuộc trò chuyện nào để xóa.', 'warning');
    return;
  }
  
  const actualCount = Math.min(count, items.length);
  if (actualCount <= 0) return;
  
  deleteBulk(actualCount);
};

const requestStop = () => {
  stopRequested = true;
  log('Đang dừng... Vui lòng đợi hết lượt click hiện tại.', 'warning');
};

const updateUIState = () => {
  const widget = document.getElementById('gemini-cleaner-widget');
  if (!widget) return;
  
  const scanBtn = widget.querySelector('#gemini-cleaner-scan-btn');
  const qtyBtn = widget.querySelector('#gemini-cleaner-del-qty-btn');
  const allBtn = widget.querySelector('#gemini-cleaner-del-all-btn');
  const qtyInput = widget.querySelector('#gemini-cleaner-qty-input');
  const progressSec = widget.querySelector('#gemini-cleaner-progress-sec');
  
  if (isRunning) {
    scanBtn.disabled = true;
    qtyBtn.disabled = true;
    allBtn.disabled = true;
    qtyInput.disabled = true;
    progressSec.style.display = 'flex';
  } else {
    scanBtn.disabled = false;
    qtyBtn.disabled = false;
    allBtn.disabled = false;
    qtyInput.disabled = false;
    progressSec.style.display = 'none';
  }
};

const updateProgressBar = (current, total) => {
  const bar = document.getElementById('gemini-cleaner-progress-bar');
  const percentText = document.getElementById('gemini-cleaner-progress-percent');
  const label = document.getElementById('gemini-cleaner-progress-label');
  
  if (!bar || !percentText || !label) return;
  
  const pct = Math.round((current / total) * 100);
  bar.style.width = `${pct}%`;
  percentText.innerText = `${pct}%`;
  label.innerText = `Đang xóa: ${current} / ${total}...`;
};

// Create the control panel widget
const createWidget = () => {
  if (document.getElementById('gemini-cleaner-widget')) return;
  
  const widget = document.createElement('div');
  widget.id = 'gemini-cleaner-widget';
  
  widget.innerHTML = `
    <div class="gemini-cleaner-header">
      <div class="gemini-cleaner-title-container">
        <span class="gemini-cleaner-sparkle">✦</span>
        <span class="gemini-cleaner-title">Gemini Cleaner</span>
      </div>
      <button class="gemini-cleaner-toggle-btn" id="gemini-cleaner-close-btn" title="Ẩn bảng điều khiển">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <line x1="18" y1="6" x2="6" y2="18"></line>
          <line x1="6" y1="6" x2="18" y2="18"></line>
        </svg>
      </button>
    </div>
    <div class="gemini-cleaner-body">
      <div class="gemini-cleaner-chat-count">
        <span class="gemini-cleaner-status-label">Số cuộc trò chuyện:</span>
        <span class="gemini-cleaner-status-value" id="gemini-cleaner-count-val">0</span>
      </div>
      
      <button class="gemini-cleaner-btn gemini-cleaner-btn-secondary" id="gemini-cleaner-scan-btn">
        Quét danh sách chat
      </button>
      
      <div class="gemini-cleaner-input-group">
        <input type="number" id="gemini-cleaner-qty-input" class="gemini-cleaner-number-input" value="10" min="1" max="100">
        <button class="gemini-cleaner-btn gemini-cleaner-btn-primary" id="gemini-cleaner-del-qty-btn" style="flex: 1;">
          Xóa N chats gần nhất
        </button>
      </div>
      
      <button class="gemini-cleaner-btn gemini-cleaner-btn-danger" id="gemini-cleaner-del-all-btn">
        Xóa tất cả đang hiển thị
      </button>
      
      <!-- Progress Section -->
      <div class="gemini-cleaner-progress-container" id="gemini-cleaner-progress-sec" style="display: none;">
        <div class="gemini-cleaner-status-row">
          <span class="gemini-cleaner-status-label" id="gemini-cleaner-progress-label">Đang chuẩn bị...</span>
          <span class="gemini-cleaner-status-value" id="gemini-cleaner-progress-percent">0%</span>
        </div>
        <div class="gemini-cleaner-progress-bar-bg">
          <div class="gemini-cleaner-progress-bar-fill" id="gemini-cleaner-progress-bar"></div>
        </div>
        <button class="gemini-cleaner-btn gemini-cleaner-btn-warning" id="gemini-cleaner-stop-btn">
          Dừng lại
        </button>
      </div>
      
      <!-- Logs Toggle -->
      <div style="display: flex; justify-content: flex-end;">
        <button class="gemini-cleaner-btn gemini-cleaner-btn-secondary" id="gemini-cleaner-toggle-log-btn" style="padding: 4px 8px; font-size: 10px; width: auto; box-shadow: 2px 2px 0px #8ab4f8; margin-top: 4px;">
          Hiện nhật ký
        </button>
      </div>

      <!-- Logs -->
      <div class="gemini-cleaner-logs" style="display: none;">
        <div class="gemini-cleaner-log-item info">[Hệ thống] Đã tải Gemini Cleaner. Nhấp "Quét" để bắt đầu.</div>
      </div>
    </div>
  `;
  
  document.body.appendChild(widget);
  
  // Set up event listeners
  const closeBtn = widget.querySelector('#gemini-cleaner-close-btn');
  closeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    widget.style.display = 'none';
  });
  
  const scanBtn = widget.querySelector('#gemini-cleaner-scan-btn');
  scanBtn.addEventListener('click', scanConversations);
  
  const qtyBtn = widget.querySelector('#gemini-cleaner-del-qty-btn');
  qtyBtn.addEventListener('click', () => {
    const qtyInput = widget.querySelector('#gemini-cleaner-qty-input');
    const qty = parseInt(qtyInput.value) || 10;
    startDeletionProcess(qty);
  });
  
  const allBtn = widget.querySelector('#gemini-cleaner-del-all-btn');
  allBtn.addEventListener('click', () => {
    const items = getConversationItems();
    if (items.length === 0) {
      log('Không tìm thấy cuộc trò chuyện nào. Hãy quét trước.', 'warning');
      return;
    }
    if (confirm(`Bạn có chắc chắn muốn xóa TẤT CẢ ${items.length} cuộc trò chuyện đang hiển thị?`)) {
      startDeletionProcess(items.length);
    }
  });
  
  const stopBtn = widget.querySelector('#gemini-cleaner-stop-btn');
  stopBtn.addEventListener('click', requestStop);
  
  const toggleLogBtn = widget.querySelector('#gemini-cleaner-toggle-log-btn');
  toggleLogBtn.addEventListener('click', () => {
    const logBox = widget.querySelector('.gemini-cleaner-logs');
    if (logBox.style.display === 'none') {
      logBox.style.display = 'flex';
      toggleLogBtn.innerText = 'Ẩn nhật ký';
    } else {
      logBox.style.display = 'none';
      toggleLogBtn.innerText = 'Hiện nhật ký';
    }
  });
};

// Listen for messages from the background service worker to toggle visibility
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "toggle_cleaner") {
    const widget = document.getElementById('gemini-cleaner-widget');
    if (widget) {
      // Toggle visibility
      if (widget.style.display === 'none') {
        widget.style.display = 'block';
        log('Bảng điều khiển đã được hiển thị.', 'info');
      } else {
        widget.style.display = 'none';
      }
    } else {
      // Create and display widget for the first time
      if (document.body) {
        createWidget();
        const newWidget = document.getElementById('gemini-cleaner-widget');
        if (newWidget) {
          newWidget.style.display = 'block';
        }
        log('Gemini Cleaner đã được kích hoạt thành công!', 'success');
      } else {
        console.warn("Chưa thể hiển thị panel do document.body chưa sẵn sàng.");
      }
    }
  }
});
