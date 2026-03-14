/* ===== ReScanner — Reselling Inventory Scanner ===== */

(function () {
  'use strict';

  // ── State ──
  let scanning = false;
  let currentPhotoData = { scan: null, manual: null };

  // ── DOM Refs ──
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  const tabs = $$('.tab');
  const panels = $$('.tab-panel');
  const toastEl = $('#toast');

  // Scanner
  const scannerViewport = $('#scanner-viewport');
  const scannerPlaceholder = $('#scanner-placeholder');
  const scannerOverlay = $('#scanner-overlay');
  const btnStartScan = $('#btn-start-scan');
  const btnStopScan = $('#btn-stop-scan');
  const barcodeInput = $('#barcode-input');
  const btnLookup = $('#btn-lookup');
  const lookupResult = $('#lookup-result');
  const resultInfo = $('#result-info');
  const scanFormWrap = $('#scan-form-wrap');

  // Stats
  const statCount = $('#stat-count');
  const statSpent = $('#stat-spent');
  const statPotential = $('#stat-potential');

  // History
  const historyList = $('#history-list');
  const emptyHistory = $('#empty-history');
  const btnDownloadCSV = $('#btn-download-csv');
  const btnClearSession = $('#btn-clear-session');

  // ── Storage Helpers (in-memory store for session data) ──
  const STORAGE_KEY = 'rescanner_items';
  let _store = { items: [] };

  function getItems() {
    return Array.isArray(_store.items) ? [..._store.items] : [];
  }

  function saveItems(items) {
    _store.items = Array.isArray(items) ? [...items] : [];
  }

  function addItem(item) {
    const items = getItems();
    item.id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    item.timestamp = new Date().toISOString();
    items.push(item);
    saveItems(items);
    updateStats();
    renderHistory();
    return item;
  }

  // ── Toast ──
  let toastTimeout;
  function showToast(message, type = '') {
    clearTimeout(toastTimeout);
    toastEl.textContent = message;
    toastEl.className = 'toast visible ' + type;
    toastTimeout = setTimeout(() => {
      toastEl.className = 'toast';
    }, 2500);
  }

  // ── Tab Navigation ──
  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      const target = tab.dataset.tab;
      tabs.forEach((t) => {
        t.classList.remove('active');
        t.setAttribute('aria-selected', 'false');
      });
      tab.classList.add('active');
      tab.setAttribute('aria-selected', 'true');

      panels.forEach((p) => {
        p.classList.remove('active');
        p.hidden = true;
      });
      const panel = $(`#panel-${target}`);
      panel.classList.add('active');
      panel.hidden = false;

      // Stop scanner when leaving scan tab
      if (target !== 'scan' && scanning) {
        stopScanner();
      }
    });
  });

  // ── Barcode Scanner (Quagga2) ──
  function startScanner() {
    if (scanning) return;

    // Check if Quagga is loaded
    if (typeof Quagga === 'undefined') {
      showToast('Scanner library not loaded', 'error');
      return;
    }

    scannerPlaceholder.style.display = 'none';
    scannerOverlay.hidden = false;
    btnStartScan.hidden = true;
    btnStopScan.hidden = false;

    Quagga.init({
      inputStream: {
        name: 'Live',
        type: 'LiveStream',
        target: scannerViewport,
        constraints: {
          facingMode: 'environment',
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
      },
      decoder: {
        readers: [
          'ean_reader',
          'ean_8_reader',
          'upc_reader',
          'upc_e_reader',
          'code_128_reader',
          'code_39_reader',
        ],
      },
      locate: true,
      frequency: 10,
    }, function (err) {
      if (err) {
        console.error('Quagga init error:', err);
        showToast('Camera access denied or not available', 'error');
        resetScannerUI();
        return;
      }
      Quagga.start();
      scanning = true;
    });

    Quagga.onDetected(onBarcodeDetected);
  }

  function stopScanner() {
    if (!scanning) return;
    try {
      Quagga.stop();
      Quagga.offDetected(onBarcodeDetected);
    } catch (e) {
      console.warn('Error stopping Quagga:', e);
    }
    scanning = false;
    resetScannerUI();
  }

  function resetScannerUI() {
    scannerPlaceholder.style.display = '';
    scannerOverlay.hidden = true;
    btnStartScan.hidden = false;
    btnStopScan.hidden = true;
    // Remove video elements from Quagga
    const video = scannerViewport.querySelector('video');
    const canvas = scannerViewport.querySelector('canvas');
    if (video) video.remove();
    if (canvas) canvas.remove();
  }

  function onBarcodeDetected(result) {
    const code = result.codeResult.code;
    if (!code) return;

    // Basic validation: debounce repeat scans
    stopScanner();
    barcodeInput.value = code;
    showToast('Barcode detected: ' + code, 'success');
    lookupBarcode(code);
  }

  // ── Barcode Lookup ──
  async function lookupBarcode(barcode) {
    lookupResult.hidden = false;
    resultInfo.innerHTML = '<div class="spinner"></div>';
    $('#result-title').textContent = 'Looking up\u2026';

    let productData = null;

    // Try UPC Item DB first
    try {
      const resp = await fetch(`https://api.upcitemdb.com/prod/trial/lookup?upc=${barcode}`);
      if (resp.ok) {
        const data = await resp.json();
        if (data.items && data.items.length > 0) {
          const item = data.items[0];
          productData = {
            name: item.title || '',
            brand: item.brand || '',
            category: item.category || '',
            description: item.description || '',
            image: item.images && item.images.length > 0 ? item.images[0] : null,
          };
        }
      }
    } catch (e) {
      console.warn('UPC lookup failed:', e);
    }

    // Try Open Food Facts if UPC didn't work
    if (!productData) {
      try {
        const resp = await fetch(`https://world.openfoodfacts.org/api/v0/product/${barcode}.json`);
        if (resp.ok) {
          const data = await resp.json();
          if (data.status === 1 && data.product) {
            const p = data.product;
            productData = {
              name: p.product_name || p.generic_name || '',
              brand: p.brands || '',
              category: p.categories ? p.categories.split(',')[0].trim() : '',
              description: '',
              image: p.image_url || null,
            };
          }
        }
      } catch (e) {
        console.warn('Open Food Facts lookup failed:', e);
      }
    }

    if (productData && productData.name) {
      $('#result-title').textContent = 'Product Found';
      let html = '';
      if (productData.name) html += `<p><strong>Name:</strong> ${escapeHtml(productData.name)}</p>`;
      if (productData.brand) html += `<p><strong>Brand:</strong> ${escapeHtml(productData.brand)}</p>`;
      if (productData.category) html += `<p><strong>Category:</strong> ${escapeHtml(productData.category)}</p>`;
      if (productData.description) html += `<p><strong>Description:</strong> ${escapeHtml(productData.description.slice(0, 150))}</p>`;
      resultInfo.innerHTML = html;

      // Pre-fill form
      showScanForm(barcode, productData);
    } else {
      $('#result-title').textContent = 'Not Found';
      resultInfo.innerHTML = `<p>No product info found for barcode <strong>${escapeHtml(barcode)}</strong>. You can fill in the details manually below.</p>`;
      showScanForm(barcode, { name: '', brand: '', category: '' });
    }
  }

  function showScanForm(barcode, data) {
    scanFormWrap.hidden = false;
    $('#scan-barcode').value = barcode;
    $('#scan-name').value = data.name || '';
    $('#scan-brand').value = data.brand || '';

    // Try to match category
    if (data.category) {
      const catSelect = $('#scan-category');
      const opts = Array.from(catSelect.options);
      const match = opts.find(o => o.value.toLowerCase().includes(data.category.toLowerCase()));
      if (match) catSelect.value = match.value;
    }

    // Scroll to form
    scanFormWrap.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // ── Form Submission ──
  function getFormData(form, prefix) {
    return {
      barcode: form.querySelector(`#${prefix}-barcode`)?.value || '',
      name: form.querySelector(`#${prefix}-name`).value.trim(),
      category: form.querySelector(`#${prefix}-category`).value,
      brand: form.querySelector(`#${prefix}-brand`).value.trim(),
      condition: form.querySelector(`#${prefix}-condition`).value,
      source: form.querySelector(`#${prefix}-source`).value,
      purchasePrice: parseFloat(form.querySelector(`#${prefix}-purchase-price`).value) || 0,
      listingPrice: parseFloat(form.querySelector(`#${prefix}-listing-price`).value) || 0,
      platform: form.querySelector(`#${prefix}-platform`).value,
      storageLocation: form.querySelector(`#${prefix}-storage`).value.trim(),
      notes: form.querySelector(`#${prefix}-notes`).value.trim(),
      photo: currentPhotoData[prefix] || null,
    };
  }

  function handleFormSubmit(e, prefix) {
    e.preventDefault();
    const form = e.target;
    const data = getFormData(form, prefix);

    if (!data.name) {
      showToast('Item name is required', 'error');
      return;
    }

    addItem(data);
    showToast('Item saved!', 'success');

    // Reset form
    form.reset();
    currentPhotoData[prefix] = null;
    const preview = $(`#${prefix}-photo-preview`);
    if (preview) preview.hidden = true;

    // Hide scan form and result if scan tab
    if (prefix === 'scan') {
      scanFormWrap.hidden = true;
      lookupResult.hidden = true;
    }
  }

  $('#scan-item-form').addEventListener('submit', (e) => handleFormSubmit(e, 'scan'));
  $('#manual-item-form').addEventListener('submit', (e) => handleFormSubmit(e, 'manual'));

  // ── Copy to Clipboard ──
  function copyFormToClipboard(prefix) {
    const form = document.querySelector(`#${prefix}-item-form`);
    const data = getFormData(form, prefix);

    if (!data.name) {
      showToast('Fill in at least the item name', 'error');
      return;
    }

    // Tab-separated values matching typical Google Sheets columns
    const row = [
      new Date().toLocaleDateString(),
      data.name,
      data.barcode,
      data.category,
      data.brand,
      data.condition,
      data.source,
      '$' + data.purchasePrice.toFixed(2),
      '$' + data.listingPrice.toFixed(2),
      data.platform,
      data.storageLocation,
      data.notes,
    ].join('\t');

    navigator.clipboard.writeText(row).then(() => {
      showToast('Copied to clipboard!', 'success');
    }).catch(() => {
      // Fallback
      const ta = document.createElement('textarea');
      ta.value = row;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy');
        showToast('Copied to clipboard!', 'success');
      } catch {
        showToast('Copy failed \u2014 try manually', 'error');
      }
      document.body.removeChild(ta);
    });
  }

  $('#scan-copy-btn').addEventListener('click', () => copyFormToClipboard('scan'));
  $('#manual-copy-btn').addEventListener('click', () => copyFormToClipboard('manual'));

  // ── Photo Capture ──
  function setupPhotoCapture(prefix) {
    const btn = $(`#${prefix}-photo-btn`);
    const input = $(`#${prefix}-photo-input`);
    const preview = $(`#${prefix}-photo-preview`);
    const img = $(`#${prefix}-photo-img`);
    const removeBtn = $(`#${prefix}-remove-photo`);

    btn.addEventListener('click', () => input.click());

    input.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;

      const reader = new FileReader();
      reader.onload = (ev) => {
        img.src = ev.target.result;
        currentPhotoData[prefix] = ev.target.result;
        preview.hidden = false;
      };
      reader.readAsDataURL(file);
    });

    removeBtn.addEventListener('click', () => {
      input.value = '';
      currentPhotoData[prefix] = null;
      preview.hidden = true;
      img.src = '';
    });
  }

  setupPhotoCapture('scan');
  setupPhotoCapture('manual');

  // ── Scanner Controls ──
  btnStartScan.addEventListener('click', startScanner);
  btnStopScan.addEventListener('click', stopScanner);

  scannerPlaceholder.addEventListener('click', startScanner);

  btnLookup.addEventListener('click', () => {
    const code = barcodeInput.value.trim();
    if (!code) {
      showToast('Enter a barcode number', 'error');
      return;
    }
    lookupBarcode(code);
  });

  barcodeInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      btnLookup.click();
    }
  });

  $('#btn-close-result').addEventListener('click', () => {
    lookupResult.hidden = true;
  });

  // ── Stats ──
  function updateStats() {
    const items = getItems();
    const today = new Date().toDateString();
    const todayItems = items.filter(i => new Date(i.timestamp).toDateString() === today);

    const count = todayItems.length;
    const spent = todayItems.reduce((sum, i) => sum + (i.purchasePrice || 0), 0);
    const potential = todayItems.reduce((sum, i) => sum + (i.listingPrice || 0), 0);

    statCount.textContent = count;
    statSpent.textContent = '$' + spent.toFixed(2);
    statPotential.textContent = '$' + potential.toFixed(2);
  }

  // ── History ──
  function renderHistory() {
    const items = getItems();
    const today = new Date().toDateString();
    const todayItems = items.filter(i => new Date(i.timestamp).toDateString() === today);

    if (todayItems.length === 0) {
      emptyHistory.hidden = false;
      historyList.querySelectorAll('.history-item').forEach(el => el.remove());
      return;
    }

    emptyHistory.hidden = true;

    // Clear and re-render
    historyList.querySelectorAll('.history-item').forEach(el => el.remove());

    todayItems.reverse().forEach((item) => {
      const el = document.createElement('div');
      el.className = 'history-item';
      el.innerHTML = `
        <div class="history-item-icon">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="7" width="20" height="14" rx="2" ry="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/></svg>
        </div>
        <div class="history-item-info">
          <div class="history-item-name">${escapeHtml(item.name)}</div>
          <div class="history-item-meta">${escapeHtml(item.category || 'Uncategorized')}${item.source ? ' \u00b7 ' + escapeHtml(item.source) : ''}</div>
        </div>
        <div class="history-item-price">
          ${item.purchasePrice ? '$' + item.purchasePrice.toFixed(2) : '\u2014'}
        </div>
        <div class="history-item-actions">
          <button class="btn-icon" aria-label="Copy to clipboard" data-copy-id="${item.id}">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
          </button>
          <button class="btn-icon" aria-label="Delete item" data-delete-id="${item.id}">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
          </button>
        </div>
      `;
      historyList.appendChild(el);
    });

    // Bind actions
    historyList.querySelectorAll('[data-copy-id]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const item = items.find(i => i.id === btn.dataset.copyId);
        if (!item) return;
        const row = [
          new Date(item.timestamp).toLocaleDateString(),
          item.name,
          item.barcode || '',
          item.category || '',
          item.brand || '',
          item.condition || '',
          item.source || '',
          '$' + (item.purchasePrice || 0).toFixed(2),
          '$' + (item.listingPrice || 0).toFixed(2),
          item.platform || '',
          item.storageLocation || '',
          item.notes || '',
        ].join('\t');
        navigator.clipboard.writeText(row).then(() => {
          showToast('Row copied!', 'success');
        }).catch(() => {
          showToast('Copy failed', 'error');
        });
      });
    });

    historyList.querySelectorAll('[data-delete-id]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.deleteId;
        const items = getItems();
        const filtered = items.filter(i => i.id !== id);
        saveItems(filtered);
        updateStats();
        renderHistory();
        showToast('Item removed', '');
      });
    });
  }

  // ── CSV Export ──
  btnDownloadCSV.addEventListener('click', () => {
    const items = getItems();
    if (items.length === 0) {
      showToast('No items to export', 'error');
      return;
    }

    const headers = ['Date', 'Name', 'Barcode', 'Category', 'Brand', 'Condition', 'Source', 'Purchase Price', 'Listing Price', 'Platform', 'Storage Location', 'Notes'];
    const rows = items.map(i => [
      new Date(i.timestamp).toLocaleDateString(),
      i.name,
      i.barcode || '',
      i.category || '',
      i.brand || '',
      i.condition || '',
      i.source || '',
      (i.purchasePrice || 0).toFixed(2),
      (i.listingPrice || 0).toFixed(2),
      i.platform || '',
      i.storageLocation || '',
      i.notes || '',
    ]);

    let csv = headers.map(h => `"${h}"`).join(',') + '\n';
    rows.forEach(row => {
      csv += row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(',') + '\n';
    });

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `rescanner-inventory-${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('CSV downloaded!', 'success');
  });

  // ── Clear Session ──
  btnClearSession.addEventListener('click', () => {
    if (!confirm('Clear all items from this session?')) return;
    saveItems([]);
    updateStats();
    renderHistory();
    showToast('Session cleared', '');
  });

  // ── Utilities ──
  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // ── Init ──
  updateStats();
  renderHistory();

  // Register Service Worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('service-worker.js').catch((err) => {
      console.warn('SW registration failed:', err);
    });
  }

})();