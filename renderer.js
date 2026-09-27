const { ipcRenderer } = require('electron');

let xmlData = null;
let currentFilePath = 'C:\\clips\\dbWCT.xml';
let selectedBoard = null;
let selectedClip = null;
let selectedBoardData = null;
let selectedClipData = null;

// Active Option: 0 = None selected, 1 = Récepteur (XML), 2 = Saisie Manuelle (XML), 3 = Récepteur Direct & Ticket (Sans XML)
let currentOption = 0;

// Signal Acquisition State
let pendingSignalValue = null;
let pendingHexCode = null;
let matchingSignalCount = 0;
let newValueConfirmed = false;
let configuredComPort = 'COM3';
let isPortOpen = false;
let isReceivingSignal = false;
const REQUIRED_SIGNAL_MATCHES = 3;

// ── Multi-Transmitter Auto-Detection ──────────────────────────────────────────
// Maps hexCode → { count, decId, lastSeen }
// When any transmitter reaches REQUIRED_SIGNAL_MATCHES → auto-confirm
let transmitterClickCounts = {};
let lastActiveTransmitter = null; // { hex, dec, count }
let opt3Confirmed = false;     // True once a transmitter is auto-confirmed in Opt3
let opt3PortConnected = false;  // True when port is open for Option 3 stream
let opt1Confirmed = false;     // True once a transmitter is auto-confirmed in Opt1
let opt1PortConnected = false;  // True when port is open for Option 1 stream

// Debounce: track last-seen time per hexCode to prevent one physical press
// from generating multiple rapid counts (receiver hardware sends multiple packets)
const TX_DEBOUNCE_MS = 400; // ms to ignore repeats from same hex after a count
let transmitterLastCountedAt = {}; // hexCode → timestamp of last counted click

// Manual Hex Conversion State (Option 2)
let currentManualConvertedId = null;
let currentManualHexInput = '';
let lastAutoCopiedSelectionKey = null;

// Confirmed Signal State for Ticket (Option 3)
let lastConfirmedHexCode = 'FEE7DF';
let lastConfirmedDecId = '';

// SVG Status Icons
const ICON_SUCCESS = `
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
    <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path>
    <polyline points="22 4 12 14.01 9 11.01"></polyline>
  </svg>
`;

const ICON_ERROR = `
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="12" cy="12" r="10"></circle>
    <line x1="15" y1="9" x2="9" y2="15"></line>
    <line x1="9" y1="9" x2="15" y2="15"></line>
  </svg>
`;

const ICON_INFO = `
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#667eea" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="12" cy="12" r="10"></circle>
    <line x1="12" y1="16" x2="12" y2="12"></line>
    <line x1="12" y1="8" x2="12.01" y2="8"></line>
  </svg>
`;

// Helper: Update Port Connection Badge in Header & UI
function updatePortUI(isOpen, portName) {
  isPortOpen = isOpen;
  if (portName) {
    configuredComPort = portName;
    syncComPortDropdowns(portName);
  }

  const badge = document.getElementById('headerPortStatus');
  const text = document.getElementById('headerPortText');
  if (badge && text) {
    if (isOpen) {
      badge.className = 'port-pill connected';
      text.textContent = `${configuredComPort} EN LIGNE (ÉCOUTE ACTIVE)`;
    } else {
      badge.className = 'port-pill';
      text.textContent = 'PORT HORS LIGNE';
    }
  }

  // Update acquire button state in Option 1 & 3
  updateAcquireButtonsState(isOpen);

  // Update Option 3 Port labels
  const livePort = document.getElementById('opt3LivePort');
  const ticketPort = document.getElementById('ticketOpt3Port');
  const printPort = document.getElementById('printPort');
  if (livePort) livePort.textContent = configuredComPort;
  if (ticketPort) ticketPort.textContent = configuredComPort;
  if (printPort) printPort.textContent = configuredComPort;
}

function updateAcquireButtonsState(isListening) {
  const btn1 = document.getElementById('btnAcquireOpt1');
  const btn3 = document.getElementById('btnAcquireOpt3');

  const setBtn = (btn, isOption3) => {
    if (!btn) return;
    if (isListening) {
      btn.classList.add('listening');
      btn.innerHTML = `
        <span style="display:inline-block; width:8px; height:8px; border-radius:50%; background:#10b981; box-shadow:0 0 8px #10b981; margin-right:6px;"></span>
        Port Connecté - En Écoute Continue...
      `;
    } else {
      btn.classList.remove('listening');
      btn.innerHTML = `
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M4.9 19.1C1 15.2 1 8.8 4.9 4.9"></path>
          <path d="M7.8 16.2c-2.3-2.3-2.3-6.1 0-8.5"></path>
          <circle cx="12" cy="12" r="2"></circle>
          <path d="M16.2 7.8c2.3 2.3 2.3 6.1 0 8.5"></path>
          <path d="M19.1 4.9C23 8.8 23 15.2 19.1 19.1"></path>
        </svg>
        ${isOption3 ? 'Connecter &amp; Acquérir Signal' : 'Ouvrir Port &amp; Acquérir Signal'}
      `;
    }
  };

  setBtn(btn1, false);
  setBtn(btn3, true);
}

// Synchronize all COM port select elements with current port
function syncComPortDropdowns(portName) {
  const sel1 = document.getElementById('comSelectOpt1');
  const sel3 = document.getElementById('comSelectOpt3');

  const updateSelect = (selectEl) => {
    if (!selectEl) return;
    let found = false;
    for (let i = 0; i < selectEl.options.length; i++) {
      if (selectEl.options[i].value === portName) {
        selectEl.selectedIndex = i;
        found = true;
        break;
      }
    }
    if (!found) {
      const opt = document.createElement('option');
      opt.value = portName;
      opt.textContent = portName;
      opt.selected = true;
      selectEl.appendChild(opt);
    }
  };

  updateSelect(sel1);
  updateSelect(sel3);
}

// User selects a different COM port from dropdown (e.g. COM3, COM5)
async function changeComPort(newPort) {
  if (!newPort) return;
  try {
    configuredComPort = newPort;
    const result = await ipcRenderer.invoke('set-com-port', newPort);
    if (result.success) {
      updatePortUI(false, newPort);
      showStatus(`Port configuré : ${newPort}`, 'info');
    } else {
      showStatus(`Erreur changement de port : ${result.message}`, 'error');
    }
  } catch (err) {
    showStatus(`Erreur port : ${err.message}`, 'error');
  }
}

// Refresh available serial ports from OS
async function refreshComPortsList() {
  try {
    const res = await ipcRenderer.invoke('list-serial-ports');
    if (res && res.success && res.ports && res.ports.length > 0) {
      const sel1 = document.getElementById('comSelectOpt1');
      const sel3 = document.getElementById('comSelectOpt3');

      const populate = (sel) => {
        if (!sel) return;
        sel.innerHTML = '';
        res.ports.forEach(p => {
          const opt = document.createElement('option');
          opt.value = p;
          opt.textContent = p;
          if (p === configuredComPort) opt.selected = true;
          sel.appendChild(opt);
        });
      };

      populate(sel1);
      populate(sel3);
      showStatus(`Ports COM détectés : ${res.ports.join(', ')}`, 'success');
    } else {
      showStatus('Aucun port COM dynamique détecté. Utilisation des ports standard COM1..COM10.', 'info');
    }
  } catch (err) {
    showStatus(`Erreur détection ports : ${err.message}`, 'error');
  }
}

// Switch Option (Tabs 1, 2, 3)
function switchOption(optionNumber) {
  currentOption = optionNumber;

  const tabBtn1 = document.getElementById('tabBtn1');
  const tabBtn3 = document.getElementById('tabBtn3');
  if (tabBtn1) {
    if (optionNumber === 3) tabBtn1.classList.remove('active');
    else tabBtn1.classList.add('active');
  }
  if (tabBtn3) {
    if (optionNumber === 3) tabBtn3.classList.add('active');
    else tabBtn3.classList.remove('active');
  }

  // Update views
  for (let i = 1; i <= 3; i++) {
    const optionView = document.getElementById(`optionView${i}`);
    if (optionView) {
      if (i === optionNumber) optionView.classList.add('active-view');
      else optionView.classList.remove('active-view');
    }
  }

  // XML Planche & Clip Selection Section:
  // Visible ONLY for Option 1 & Option 2.
  // Completely HIDDEN for Option 3! (Option 3 does not use dbWCT.xml)
  const xmlSection = document.getElementById('xmlSelectionSection');
  if (xmlSection) {
    if (optionNumber === 3) {
      xmlSection.style.display = 'none';
    } else {
      xmlSection.style.display = 'block';
    }
  }

  // Refresh inputs for the active option
  updateIdInputs();

  if (optionNumber === 2) {
    setTimeout(() => {
      const input = document.getElementById('hex-input-opt2');
      if (input) {
        input.focus();
        input.select();
      }
    }, 60);
  }
}

// Switch back to Mode Atelier (Planche & Clip)
function switchToAtelierMode() {
  const tabBtn1 = document.getElementById('tabBtn1');
  const tabBtn3 = document.getElementById('tabBtn3');
  if (tabBtn1) tabBtn1.classList.add('active');
  if (tabBtn3) tabBtn3.classList.remove('active');

  const xmlSection = document.getElementById('xmlSelectionSection');
  if (xmlSection) xmlSection.style.display = 'block';

  const opt3 = document.getElementById('optionView3');
  if (opt3) opt3.classList.remove('active-view');

  if (currentOption === 1 || currentOption === 2) {
    const activeView = document.getElementById(`optionView${currentOption}`);
    if (activeView) activeView.classList.add('active-view');
    hideModeSelection();
  } else {
    currentOption = 0;
    resetModeSelection();
  }

  updateIdInputs();
}

// Hide ONLY mode buttons after mode is chosen — ancien ID stays visible always
function hideModeSelection() {
  const modeChoiceRow = document.getElementById('modeChoiceRow');
  if (modeChoiceRow) modeChoiceRow.classList.remove('visible');
}

// Go back to mode selection (now always auto-selects Saisie Manuelle)
function resetModeSelection() {
  // Hide all option views
  for (let i = 1; i <= 3; i++) {
    const v = document.getElementById(`optionView${i}`);
    if (v) v.classList.remove('active-view');
  }
  currentOption = 0;
  // Re-trigger Saisie Manuelle if a board+clip is selected
  if (selectedBoard && selectedClip) {
    chooseModeManual();
  }
}

// Choose Mode: Récepteur (Option 1)
function chooseModeReceiver() {
  document.getElementById('btnModeReceiver').classList.add('selected');
  document.getElementById('btnModeManual').classList.remove('selected');
  switchOption(1);
  hideModeSelection();
}

// Choose Mode: Saisie Manuelle (Option 2) — only mode available
function chooseModeManual() {
  const btnM = document.getElementById('btnModeManual');
  if (btnM) btnM.classList.add('selected');
  switchOption(2);
  hideModeSelection();
  setTimeout(() => {
    const input = document.getElementById('hex-input-opt2');
    if (input) {
      input.focus();
      input.select();
    }
  }, 50);
}

// Exact OGC Hex to Decimal Conversion Algorithm
function convertHexToDecimalId(hexString) {
  if (!hexString) {
    return { valid: false, finalId: '', byteDetails: [], hexInput: '', fullDecimal: '' };
  }

  let hexInput = hexString.replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
  if (hexInput.startsWith('0X')) {
    hexInput = hexInput.substring(2);
  }

  if (hexInput.length === 0) {
    return { valid: false, finalId: '', byteDetails: [], hexInput: '', fullDecimal: '' };
  }

  // Pad with leading zero if odd length (e.g. FEE7D -> 0FEE7D)
  if (hexInput.length % 2 !== 0) {
    hexInput = '0' + hexInput;
  }

  const byteDetails = [];
  let decimalOutput = '';

  for (let i = 0; i < hexInput.length; i += 2) {
    const hexByte = hexInput.substring(i, i + 2);
    const decimalValue = parseInt(hexByte, 16);
    const paddedDec = decimalValue.toString().padStart(3, '0');
    byteDetails.push({ hex: hexByte, dec: paddedDec });
    decimalOutput += paddedDec;
  }

  let finalId = decimalOutput;
  if (finalId.length > 12) {
    finalId = finalId.substring(finalId.length - 12);
  }

  return {
    valid: true,
    hexInput,
    byteDetails,
    fullDecimal: decimalOutput,
    finalId
  };
}

// Load XML file (Only required for Option 1 & 2)
async function loadXmlData(filePath) {
  try {
    xmlData = await ipcRenderer.invoke('load-xml', filePath);

    if (xmlData && xmlData.data && xmlData.data.config && xmlData.data.config[0] && xmlData.data.config[0].comPort) {
      configuredComPort = xmlData.data.config[0].comPort[0];
      syncComPortDropdowns(configuredComPort);
    }

    renderBoards();
    renderClips();
    showStatus('Fichier dbWCT.xml chargé avec succès', 'success');

    try {
      const portStatus = await ipcRenderer.invoke('get-port-status');
      if (portStatus) {
        updatePortUI(portStatus.isOpen, portStatus.portName || configuredComPort);
      }
    } catch (e) {}
  } catch (error) {
    showStatus('Avis : dbWCT.xml non trouvé. Option 1 et 2 nécessitent ce fichier, mais l\'Option 3 fonctionne sans XML.', 'info');
  }
}

// Silently reload XML after save (preserves current board/clip selection)
async function reloadXmlAfterSave(savedBoard, savedClip) {
  try {
    xmlData = await ipcRenderer.invoke('load-xml', currentFilePath);

    if (xmlData && xmlData.data && xmlData.data.config && xmlData.data.config[0] && xmlData.data.config[0].comPort) {
      configuredComPort = xmlData.data.config[0].comPort[0];
      syncComPortDropdowns(configuredComPort);
    }

    renderBoards();
    renderClips();

    // Restore board selection
    if (savedBoard && xmlData && xmlData.data && xmlData.data.boards && xmlData.data.boards[0] && xmlData.data.boards[0].board) {
      const boards = xmlData.data.boards[0].board;
      selectedBoardData = boards.find(b => b.name && b.name[0] === savedBoard) || null;
      selectedBoard = selectedBoardData ? savedBoard : null;
      const boardSelect = document.getElementById('boardSelect');
      if (boardSelect && selectedBoard) boardSelect.value = selectedBoard;
    }

    // Restore clip selection
    if (savedClip && xmlData && xmlData.data && xmlData.data.clips && xmlData.data.clips[0] && xmlData.data.clips[0].clip) {
      const clips = xmlData.data.clips[0].clip;
      selectedClipData = clips.find(c => c.name && c.name[0] === savedClip) || null;
      selectedClip = selectedClipData ? savedClip : null;
      const clipSelect = document.getElementById('clipSelect');
      if (clipSelect && selectedClip) clipSelect.value = selectedClip;
    }

    // Refresh displayed current identifier
    const currentId = getCurrentXmlIdentifier();
    const ancienVal = document.getElementById('ancienIdValue');
    if (ancienVal) ancienVal.textContent = currentId || '—';

    console.log('[RELOAD XML] Fichier XML rechargé avec succès après sauvegarde.');
  } catch (err) {
    console.warn('[RELOAD XML] Erreur rechargement silencieux:', err.message);
  }
}

// Initialization on DOMContentLoaded
window.addEventListener('DOMContentLoaded', async () => {
  // Continuous real-time listener for incoming receiver signals
  ipcRenderer.on('receiver-signal-stream', (event, signal) => {
    handleIncomingSignal(signal);
  });

  await refreshComPortsList();
  await loadXmlData(currentFilePath);
  updateTicketDisplayOption3('FEE7DF', '', false);
});

// Render boards dropdown
function renderBoards() {
  const boardSelect = document.getElementById('boardSelect');
  if (!boardSelect) return;
  boardSelect.innerHTML = '<option value="">-- Choisir Planche --</option>';

  if (xmlData && xmlData.data && xmlData.data.boards && xmlData.data.boards[0] && xmlData.data.boards[0].board) {
    const boards = [...xmlData.data.boards[0].board].sort((a, b) => {
      const nameA = String((a && a.name && a.name[0]) || '');
      const nameB = String((b && b.name && b.name[0]) || '');
      return nameA.localeCompare(nameB, undefined, { numeric: true, sensitivity: 'base' });
    });
    boards.forEach(board => {
      const option = document.createElement('option');
      option.value = board.name[0];
      option.textContent = board.name[0];
      boardSelect.appendChild(option);
    });
  }
}

// Render clips dropdown
function renderClips() {
  const clipSelect = document.getElementById('clipSelect');
  if (!clipSelect) return;
  clipSelect.innerHTML = '<option value="">-- Choisir Clip --</option>';

  if (xmlData && xmlData.data && xmlData.data.clips && xmlData.data.clips[0] && xmlData.data.clips[0].clip) {
    const clips = [...xmlData.data.clips[0].clip].sort((a, b) => {
      const nameA = String((a && a.name && a.name[0]) || '');
      const nameB = String((b && b.name && b.name[0]) || '');
      return nameA.localeCompare(nameB, undefined, { numeric: true, sensitivity: 'base' });
    });
    clips.forEach(clip => {
      const option = document.createElement('option');
      option.value = clip.name[0];
      option.textContent = clip.name[0];
      clipSelect.appendChild(option);
    });
  }
}

// Selection handlers for Board & Clip (Options 1 & 2)
function selectBoardFromDropdown() {
  const boardSelect = document.getElementById('boardSelect');
  const boardName = boardSelect.value;

  if (boardName && xmlData && xmlData.data && xmlData.data.boards && xmlData.data.boards[0] && xmlData.data.boards[0].board) {
    const boards = xmlData.data.boards[0].board;
    selectedBoardData = boards.find(board => board.name[0] === boardName);
    selectedBoard = boardName;
  } else {
    selectedBoard = null;
    selectedBoardData = null;
  }

  lastAutoCopiedSelectionKey = null;
  updateIdInputs();
}

function selectClipFromDropdown() {
  const clipSelect = document.getElementById('clipSelect');
  const clipName = clipSelect.value;

  if (clipName && xmlData && xmlData.data && xmlData.data.clips && xmlData.data.clips[0] && xmlData.data.clips[0].clip) {
    const clips = xmlData.data.clips[0].clip;
    selectedClipData = clips.find(clip => clip.name[0] === clipName);
    selectedClip = clipName;
  } else {
    selectedClip = null;
    selectedClipData = null;
  }

  lastAutoCopiedSelectionKey = null;
  updateIdInputs();
}

function getCurrentXmlIdentifier() {
  if (selectedBoardData && selectedClipData && selectedClipData.identifiers && selectedClipData.identifiers[0] && selectedClipData.identifiers[0].board) {
    const boardId = selectedBoardData.id[0];
    const identifiers = selectedClipData.identifiers[0].board;
    const identifier = identifiers.find(id => id.$.id === boardId);
    return identifier ? identifier._ : null;
  }
  return null;
}

// Update Inputs UI
function updateIdInputs() {
  const containerOpt1 = document.getElementById('idInputsOpt1');
  const containerOpt2 = document.getElementById('idInputsOpt2');

  const hasSelection = selectedBoard && selectedClip && selectedBoardData && selectedClipData;
  const currentXmlId = hasSelection ? getCurrentXmlIdentifier() : null;

  // --- Update Ancien ID Section (new unified display) ---
  const ancienIdSection = document.getElementById('ancienIdSection');
  const ancienIdValue = document.getElementById('ancienIdValue');
  const ancienIdMeta = document.getElementById('ancienIdMeta');
  const modeChoiceRow = document.getElementById('modeChoiceRow');

  if (ancienIdSection && ancienIdValue && ancienIdMeta) {
    if (hasSelection && currentXmlId !== null) {
      ancienIdValue.textContent = currentXmlId;
      ancienIdMeta.textContent = `Planche : ${selectedBoard}  •  Clip : ${selectedClip}`;
      ancienIdSection.classList.add('visible');
      // Auto-activate Saisie Manuelle
      if (currentOption !== 2) chooseModeManual();

      // Automatically copy Identifiant Actuel when Board + Clip are selected
      const selectionKey = `${selectedBoard}___${selectedClip}___${currentXmlId}`;
      if (lastAutoCopiedSelectionKey !== selectionKey) {
        lastAutoCopiedSelectionKey = selectionKey;
        setTimeout(() => {
          copyAncienId(true);
        }, 80);
      }
    } else if (hasSelection && currentXmlId === null) {
      lastAutoCopiedSelectionKey = null;
      ancienIdValue.textContent = '— Aucun identifiant mappé —';
      ancienIdMeta.textContent = `Planche : ${selectedBoard}  •  Clip : ${selectedClip}`;
      ancienIdSection.classList.add('visible');
      // Auto-activate Saisie Manuelle
      if (currentOption !== 2) chooseModeManual();
    } else {
      lastAutoCopiedSelectionKey = null;
      ancienIdSection.classList.remove('visible');
    }
  }

  const emptyStateHtml = (msg) => `
    <div class="empty-state">
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="10"></circle>
        <line x1="12" y1="8" x2="12" y2="12"></line>
        <line x1="12" y1="16" x2="12.01" y2="16"></line>
      </svg>
      <div>${msg || 'Veuillez sélectionner une <strong>Planche</strong> et un <strong>Clip</strong> ci-dessus.'}</div>
    </div>
  `;

  // OPTION 1
  if (containerOpt1) {
    if (!hasSelection) {
      containerOpt1.innerHTML = emptyStateHtml();
    } else if (currentXmlId === null) {
      containerOpt1.innerHTML = emptyStateHtml(`Aucun identifiant mappé pour ${selectedBoard} dans ${selectedClip}.`);
    } else {
      containerOpt1.innerHTML = `
        <div class="id-manager-wrap">
          <div class="input-col">
            <label class="field-label" for="new-value-input-opt1">NOUVEL IDENTIFIANT MATÉRIEL REÇU</label>
            <input type="text" id="new-value-input-opt1" class="form-control highlight" placeholder="En attente — connectez le port puis scannez un émetteur 3×" value="${newValueConfirmed && lastConfirmedDecId ? lastConfirmedDecId : ''}" readonly>
          </div>

          <!-- Transmitter Detection Panel for Option 1 -->
          <div class="tx-panel-header">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M4.9 19.1C1 15.2 1 8.8 4.9 4.9"></path>
              <path d="M7.8 16.2c-2.3-2.3-2.3-6.1 0-8.5"></path>
              <circle cx="12" cy="12" r="2"></circle>
              <path d="M16.2 7.8c2.3 2.3 2.3 6.1 0 8.5"></path>
              <path d="M19.1 4.9C23 8.8 23 15.2 19.1 19.1"></path>
            </svg>
            ÉMETTEUR CONFIRMÉ
            <span class="tx-panel-hint">Auto-confirmé à 3 clics</span>
            <button type="button" class="btn btn-sm btn-light" onclick="resetOpt1Transmitters()" style="margin-left: 8px; padding: 2px 8px; font-size: 10px; font-weight: 700; border-radius: 12px; cursor: pointer;">Réinitialiser</button>
          </div>
          <div id="transmitterPanelOpt1" class="tx-panel">
            <div class="tx-empty">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#64748b" stroke-width="1.8">
                <path d="M4.9 19.1C1 15.2 1 8.8 4.9 4.9"></path>
                <path d="M7.8 16.2c-2.3-2.3-2.3-6.1 0-8.5"></path>
                <circle cx="12" cy="12" r="2"></circle>
                <path d="M16.2 7.8c2.3 2.3 2.3 6.1 0 8.5"></path>
                <path d="M19.1 4.9C23 8.8 23 15.2 19.1 19.1"></path>
              </svg>
              <span>En attente des signaux émetteurs...</span>
            </div>
          </div>
        </div>
      `;
      // Re-render panel if we already have transmitter data
      renderTransmitterPanel('transmitterPanelOpt1');
    }
  }

  // OPTION 2
  if (containerOpt2) {
    if (!hasSelection) {
      containerOpt2.innerHTML = emptyStateHtml();
    } else if (currentXmlId === null) {
      containerOpt2.innerHTML = emptyStateHtml(`Aucun identifiant mappé pour ${selectedBoard} dans ${selectedClip}.`);
    } else {
      containerOpt2.innerHTML = `
        <div class="id-manager-wrap">
          <div class="input-col">
            <label class="field-label" for="hex-input-opt2">SAISIR LE CODE</label>
            <input type="text" 
                   id="hex-input-opt2" 
                   class="form-control hex-input" 
                   placeholder="Entrez le code..." 
                   value="${currentManualHexInput}" 
                   autocomplete="off" 
                   spellcheck="false" 
                   oninput="onHexInputChange(this.value)"
                   onkeydown="if (event.key === 'Enter') { event.preventDefault(); onHexInputEnter(this.value); }">
          </div>
          <div class="conversion-result-card" id="conversionResultCard">
            <div class="conv-header-row">
              <div class="conv-label">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                  <polyline points="14 2 14 8 20 8"></polyline>
                  <line x1="16" y1="13" x2="8" y2="13"></line>
                  <line x1="16" y1="17" x2="8" y2="17"></line>
                  <polyline points="10 9 9 9 8 9"></polyline>
                </svg>
                RÉSULTAT CONVERSION OGC
              </div>
              <span class="conv-badge" id="convBadge">En attente de saisie Hex</span>
            </div>

            <div class="conv-output-row">
              <span class="conv-id-val" id="convResultId">${currentManualConvertedId || '—'}</span>
              <button class="btn-copy-id" id="btnCopyResult" type="button" onclick="copyConvertedId()" title="Copier le résultat converti">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                </svg>
                Copier ID
              </button>
            </div>
            <div class="conv-meta" id="convResultMeta">Identifiant décimal calculé prêt pour affectation</div>
          </div>
        </div>
      `;
      if (currentManualHexInput) {
        onHexInputChange(currentManualHexInput);
      }
    }
  }

  updateSignalConfirmStatus();
}

// Option 2: Live conversion (shows only final converted result)
function onHexInputChange(val) {
  currentManualHexInput = val || '';
  const resultEl = document.getElementById('convResultId');
  const badgeEl = document.getElementById('convBadge');

  if (!resultEl || !badgeEl) return;

  const conv = convertHexToDecimalId(currentManualHexInput);

  if (!conv.valid || !conv.finalId) {
    currentManualConvertedId = null;
    resultEl.textContent = '—';
    badgeEl.textContent = 'En attente de code Hex';
    badgeEl.className = 'conv-badge';
    return;
  }

  currentManualConvertedId = conv.finalId;
  resultEl.textContent = conv.finalId;
  badgeEl.textContent = 'Converti';
  badgeEl.className = 'conv-badge active';
}

// Automatically called when user presses Enter in Option 2 hex input
function onHexInputEnter(val) {
  onHexInputChange(val);
  if (currentManualConvertedId) {
    copyConvertedId(true);
  } else {
    showStatus('Code incomplet ou non valide pour conversion', 'warning');
  }
}

function copyConvertedId(isAuto = false) {
  if (currentManualConvertedId) {
    navigator.clipboard.writeText(currentManualConvertedId);
    const btn = document.getElementById('btnCopyResult') || document.querySelector('[onclick="copyConvertedId()"]');
    if (btn) {
      btn.classList.add('copied');
      btn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg> Copié !`;
      setTimeout(() => {
        btn.classList.remove('copied');
        btn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg> Copier ID`;
      }, 2000);
    }
    showStatus(isAuto ? `Résultat copié automatiquement : ${currentManualConvertedId}` : 'Résultat copié dans le presse-papier !', 'success');
  }
}

// Copy current Identifiant Actuel to clipboard
function copyAncienId(isAuto = false) {
  const val = document.getElementById('ancienIdValue');
  if (!val) return;
  const text = val.textContent.trim();
  if (!text || text === '—' || text.includes('Aucun')) return;
  navigator.clipboard.writeText(text);
  const btn = document.getElementById('btnCopyAncienId');
  if (btn) {
    btn.classList.add('copied');
    btn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg> Copié !`;
    setTimeout(() => {
      btn.classList.remove('copied');
      btn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg> Copier ID`;
    }, 2000);
  }
  showStatus(isAuto ? `Identifiant actuel copié automatiquement : ${text}` : 'Identifiant actuel copié dans le presse-papier !', 'success');
}

// Option 2: Save to XML
async function saveManualChanges() {
  if (!xmlData || !currentFilePath) {
    showStatus('Veuillez vérifier que le fichier XML est chargé', 'error');
    return;
  }
  if (!selectedBoard || !selectedClip) {
    showStatus('Veuillez sélectionner une Planche et un Clip avant d\'enregistrer', 'error');
    return;
  }
  if (!currentManualConvertedId) {
    const hexInp = document.getElementById('hex-input-opt2');
    if (hexInp && hexInp.value) {
      onHexInputChange(hexInp.value);
    }
  }
  if (!currentManualConvertedId) {
    showStatus('Veuillez saisir un code Hex valide avant d\'enregistrer', 'error');
    return;
  }

  try {
    const boardId = String(selectedBoardData.id[0]);
    if (xmlData.data && xmlData.data.clips && xmlData.data.clips[0] && xmlData.data.clips[0].clip) {
      const clips = xmlData.data.clips[0].clip;
      const clip = clips.find(c => c.name && c.name[0] === selectedClip);
      if (clip) {
        if (!clip.identifiers) clip.identifiers = [{}];
        if (!clip.identifiers[0].board) clip.identifiers[0].board = [];
        const identifier = clip.identifiers[0].board.find(id => id && id.$ && String(id.$.id) === boardId);
        if (identifier) {
          identifier._ = currentManualConvertedId;
        } else {
          clip.identifiers[0].board.push({ $: { id: boardId, enabled: 'True' }, _: currentManualConvertedId });
        }
      }
    }

    const saveRes = await ipcRenderer.invoke('save-xml', currentFilePath, xmlData);
    if (saveRes && saveRes.success === false) {
      showStatus(`Erreur sauvegarde XML : ${saveRes.message}`, 'error');
      return;
    }

    const ancienVal = document.getElementById('ancienIdValue');
    if (ancienVal) ancienVal.textContent = currentManualConvertedId;

    const backupMsg = saveRes && saveRes.backupCreated ? ` (Backup : ${saveRes.backupFileName})` : '';
    showStatus(`✓ Identifiant ${currentManualConvertedId} enregistré avec succès pour ${selectedClip} (${selectedBoard})${backupMsg} !`, 'success');

    // Recharger le XML en arrière-plan pour appliquer les modifications
    const _savedBoard = selectedBoard;
    const _savedClip = selectedClip;

    // Auto-réinitialisation après sauvegarde pour la saisie suivante
    currentManualHexInput = '';
    currentManualConvertedId = null;
    const hexInputEl = document.getElementById('hex-input-opt2');
    if (hexInputEl) {
      hexInputEl.value = '';
      hexInputEl.focus();
    }
    const resultEl = document.getElementById('convResultId');
    if (resultEl) resultEl.textContent = '—';
    const badgeEl = document.getElementById('convBadge');
    if (badgeEl) {
      badgeEl.textContent = 'En attente de saisie Hex';
      badgeEl.className = 'conv-badge';
    }

    // Rechargement silencieux du XML pour appliquer les modifications
    await reloadXmlAfterSave(_savedBoard, _savedClip);
  } catch (err) {
    showStatus(`Erreur sauvegarde XML : ${err.message}`, 'error');
  }
}

// ---------------- SERIAL PORT CONNECTION HANDLERS ----------------
async function openReceiverPort() {
  try {
    const result = await ipcRenderer.invoke('open-receiver-port');
    if (result.success) {
      updatePortUI(true, configuredComPort);
      showStatus(result.message, 'success');
    } else {
      updatePortUI(false, configuredComPort);
      showStatus(`Échec ouverture récepteur : ${result.message}`, 'error');
    }
  } catch (error) {
    updatePortUI(false, configuredComPort);
    showStatus(`Erreur récepteur : ${error.message}`, 'error');
  }
}

async function closeReceiverPort() {
  try {
    const result = await ipcRenderer.invoke('close-receiver-port');
    if (result.success) {
      updatePortUI(false, configuredComPort);
      showStatus(result.message, 'success');
    } else {
      showStatus(`Échec fermeture récepteur : ${result.message}`, 'error');
    }
  } catch (error) {
    showStatus(`Erreur récepteur : ${error.message}`, 'error');
  }
}

// ── OPTION 3 CONNECT PORT (streaming mode) ────────────────────────────────────
// Replaces old receiveSignalFromReceiver for Option 3.
// Simply opens the port — signals auto-stream in via receiver-signal-stream IPC.
async function connectOpt3Port() {
  if (opt3PortConnected) {
    // Already connected: disconnect
    await disconnectOpt3Port();
    return;
  }

  const btn = document.getElementById('btnAcquireOpt3');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `
      <span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:#f59e0b;box-shadow:0 0 8px #f59e0b;margin-right:6px;"></span>
      Connexion en cours...
    `;
  }

  try {
    const result = await ipcRenderer.invoke('open-receiver-port');
    if (result.success) {
      opt3PortConnected = true;
      updatePortUI(true, configuredComPort);
      showStatus(`Port ${configuredComPort} ouvert — Écoute des émetteurs active.`, 'success');
      // Update button to "connected" state
      if (btn) {
        btn.disabled = false;
        btn.classList.add('listening');
        btn.innerHTML = `
          <span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:#10b981;box-shadow:0 0 10px #10b981;animation:pulse-dot 1.8s infinite;margin-right:6px;"></span>
          Déconnecter (En Écoute...)
        `;
      }
      // Show transmitter panel
      renderTransmitterPanel();
    } else {
      opt3PortConnected = false;
      updatePortUI(false, configuredComPort);
      showStatus(`Échec connexion : ${result.message}`, 'error');
      resetConnectBtn();
    }
  } catch (err) {
    opt3PortConnected = false;
    updatePortUI(false, configuredComPort);
    showStatus(`Erreur : ${err.message}`, 'error');
    resetConnectBtn();
  }
}

async function disconnectOpt3Port() {
  try {
    await ipcRenderer.invoke('close-receiver-port');
  } catch (_) {}
  opt3PortConnected = false;
  updatePortUI(false, configuredComPort);
  showStatus('Port déconnecté.', 'info');
  resetConnectBtn();
}

function resetConnectBtn() {
  const btn = document.getElementById('btnAcquireOpt3');
  if (!btn) return;
  btn.disabled = false;
  btn.classList.remove('listening');
  btn.innerHTML = `
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M4.9 19.1C1 15.2 1 8.8 4.9 4.9"></path>
      <path d="M7.8 16.2c-2.3-2.3-2.3-6.1 0-8.5"></path>
      <circle cx="12" cy="12" r="2"></circle>
      <path d="M16.2 7.8c2.3 2.3 2.3 6.1 0 8.5"></path>
      <path d="M19.1 4.9C23 8.8 23 15.2 19.1 19.1"></path>
    </svg>
    Connecter &amp; Écouter Émetteurs
  `;
}

// ── INCOMING SIGNAL HANDLER (called for every streamed signal) ─────────────────
// Handles Option 1 AND Option 3 with the same multi-transmitter logic.
// Debounce: one physical press may send many rapid packets — only count once
// per TX_DEBOUNCE_MS window per hexCode.
function handleIncomingSignal(signal) {
  if (!signal || !signal.success) return;

  const receivedHex = String(signal.hexCode || '').trim();
  const receivedDec = String(signal.data || '').trim();

  if (!receivedHex || !receivedDec) return;

  // ── Debounce: ignore rapid repeats from the same transmitter ──────────────
  const now = Date.now();
  const lastAt = transmitterLastCountedAt[receivedHex] || 0;
  if (now - lastAt < TX_DEBOUNCE_MS) return; // same hex too soon — skip
  transmitterLastCountedAt[receivedHex] = now;

  // ── Shared multi-transmitter counting logic ───────────────────────────────
  function processMultiTransmitter(confirmed, setConfirmed, panelId, onConfirm) {
    if (confirmed) return; // already confirmed for this option

    if (!transmitterClickCounts[receivedHex]) {
      transmitterClickCounts[receivedHex] = { count: 0, decId: receivedDec };
    }
    transmitterClickCounts[receivedHex].count += 1;
    transmitterClickCounts[receivedHex].decId = receivedDec;

    const currentCount = transmitterClickCounts[receivedHex].count;
    lastActiveTransmitter = { hex: receivedHex, dec: receivedDec, count: currentCount };

    if (currentCount >= REQUIRED_SIGNAL_MATCHES) {
      setConfirmed();
      onConfirm(receivedHex, receivedDec);
    } else {
      showStatus(`Signal émetteur ${receivedHex} : ${currentCount}/${REQUIRED_SIGNAL_MATCHES} clics. Cliquez encore ${REQUIRED_SIGNAL_MATCHES - currentCount} fois.`, 'info');
    }
    renderTransmitterPanel(panelId);
  }

  if (currentOption === 3) {
    if (!opt3PortConnected) return;
    processMultiTransmitter(
      opt3Confirmed,
      () => { opt3Confirmed = true; lastConfirmedHexCode = receivedHex; lastConfirmedDecId = receivedDec; },
      'transmitterPanel',
      (hex, dec) => {
        updateTicketDisplayOption3(hex, dec, true);
        showStatus(`✓ CONFIRMÉ : Émetteur ${hex} validé (3 clics) ! Ticket prêt à imprimer.`, 'success');
        const liveHex = document.getElementById('opt3LiveHex');
        const liveDec = document.getElementById('opt3LiveDec');
        if (liveHex) liveHex.textContent = hex;
        if (liveDec) liveDec.textContent = dec;
      }
    );

  } else if (currentOption === 1) {
    if (!opt1PortConnected) return;
    processMultiTransmitter(
      opt1Confirmed,
      () => { opt1Confirmed = true; lastConfirmedHexCode = receivedHex; lastConfirmedDecId = receivedDec;
               newValueConfirmed = true; },
      'transmitterPanelOpt1',
      (hex, dec) => {
        const inp1 = document.getElementById('new-value-input-opt1');
        if (inp1) inp1.value = dec;
        updateSignalConfirmStatus();
        showStatus(`✓ CONFIRMÉ : Émetteur ${hex} validé (${dec}). Cliquez sur Enregistrer.`, 'success');
      }
    );
  }
}

// ── TRANSMITTER PANEL RENDERER ─────────────────────────────────────────────────
// Shows ONLY the transmitter that has been clicked 3 times (confirmed).
// Does NOT display all clicked transmitters.
// While clicks are accumulating, shows a clean, single active progress card.
function renderTransmitterPanel(panelId) {
  const id = panelId || 'transmitterPanel';
  const panel = document.getElementById(id);
  if (!panel) return;

  const entries = Object.entries(transmitterClickCounts);
  const confirmedEntry = entries.find(([hex, info]) => info.count >= REQUIRED_SIGNAL_MATCHES);

  if (confirmedEntry) {
    // ONLY show the confirmed transmitter!
    const [hex, info] = confirmedEntry;
    panel.innerHTML = `
      <div class="tx-card tx-confirmed" id="txCard-${hex}">
        <div class="tx-card-top">
          <div class="tx-info">
            <span class="tx-hex">${hex}</span>
            <span class="tx-dec">${info.decId}</span>
          </div>
          <div class="tx-count-badge confirmed">
            ✓ 3 / 3 CLICS CONFIRMÉS
          </div>
        </div>
        <div class="tx-progress-track">
          <div class="tx-progress-bar full" style="width:100%;"></div>
        </div>
        <div class="tx-click-dots">
          <span class="tx-dot done"></span>
          <span class="tx-dot done"></span>
          <span class="tx-dot done"></span>
          <span class="tx-dot-label">Émetteur validé avec succès !</span>
        </div>
      </div>
    `;
    return;
  }

  // If not yet confirmed, check if an émetteur is currently being clicked
  if (lastActiveTransmitter && lastActiveTransmitter.count > 0) {
    const count = lastActiveTransmitter.count;
    const remaining = Math.max(0, REQUIRED_SIGNAL_MATCHES - count);
    const pct = Math.min((count / REQUIRED_SIGNAL_MATCHES) * 100, 100);
    panel.innerHTML = `
      <div class="tx-card tx-active" style="border-color: #38bdf8; background: #f0f9ff;">
        <div class="tx-card-top">
          <div class="tx-info">
            <span class="tx-hex" style="color: #0284c7;">${lastActiveTransmitter.hex}</span>
            <span class="tx-dec">${lastActiveTransmitter.dec}</span>
          </div>
          <div class="tx-count-badge almost" style="background: #e0f2fe; color: #0369a1; border-color: #bae6fd;">
            ${count} / ${REQUIRED_SIGNAL_MATCHES} CLICS
          </div>
        </div>
        <div class="tx-progress-track">
          <div class="tx-progress-bar" style="width:${pct}%; background: linear-gradient(90deg, #0284c7, #38bdf8);"></div>
        </div>
        <div class="tx-click-dots">
          ${[1, 2, 3].map(i => `<span class="tx-dot ${count >= i ? 'hit' : ''}"></span>`).join('')}
          <span class="tx-dot-label" style="color: #0369a1; font-weight: 700;">Cliquez encore ${remaining} fois sur cet émetteur</span>
        </div>
      </div>
    `;
    return;
  }

  // Empty initial state: waiting for signals
  panel.innerHTML = `
    <div class="tx-empty">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#64748b" stroke-width="1.8">
        <path d="M4.9 19.1C1 15.2 1 8.8 4.9 4.9"></path>
        <path d="M7.8 16.2c-2.3-2.3-2.3-6.1 0-8.5"></path>
        <circle cx="12" cy="12" r="2"></circle>
        <path d="M16.2 7.8c2.3 2.3 2.3 6.1 0 8.5"></path>
        <path d="M19.1 4.9C23 8.8 23 15.2 19.1 19.1"></path>
      </svg>
      <span>En attente : cliquez 3 fois sur un émetteur pour le valider...</span>
    </div>
  `;
}

// Option 1 Connect / Listen to Transmitters (streaming mode)
async function connectOpt1Port() {
  // Option 1: toggle port open/close
  if (opt1PortConnected) {
    // Already connected: close port
    try { await ipcRenderer.invoke('close-receiver-port'); } catch (_) {}
    opt1PortConnected = false;
    updatePortUI(false, configuredComPort);
    showStatus('Port fermé.', 'info');
    const btn = document.getElementById('btnAcquireOpt1');
    if (btn) {
      btn.classList.remove('listening');
      btn.innerHTML = `
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M4.9 19.1C1 15.2 1 8.8 4.9 4.9"></path>
          <path d="M7.8 16.2c-2.3-2.3-2.3-6.1 0-8.5"></path>
          <circle cx="12" cy="12" r="2"></circle>
          <path d="M16.2 7.8c2.3 2.3 2.3 6.1 0 8.5"></path>
          <path d="M19.1 4.9C23 8.8 23 15.2 19.1 19.1"></path>
        </svg>
        Ouvrir Port &amp; Écouter Émetteurs
      `;
    }
    return;
  }

  // Open port
  if (isReceivingSignal) return;
  isReceivingSignal = true;

  const btn = document.getElementById('btnAcquireOpt1');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `
      <span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:#f59e0b;box-shadow:0 0 8px #f59e0b;margin-right:6px;"></span>
      Connexion en cours...
    `;
  }

  try {
    const openResult = await ipcRenderer.invoke('open-receiver-port');
    if (!openResult.success) {
      updatePortUI(false, configuredComPort);
      showStatus(`Échec récepteur sur ${configuredComPort} : ${openResult.message}`, 'error');
      if (btn) { btn.disabled = false; btn.innerHTML = 'Ouvrir Port &amp; Écouter Émetteurs'; }
      return;
    }
    opt1PortConnected = true;
    updatePortUI(true, configuredComPort);
    showStatus(`Récepteur actif sur ${configuredComPort}. Scannez vos émetteurs...`, 'success');
    if (btn) {
      btn.disabled = false;
      btn.classList.add('listening');
      btn.innerHTML = `
        <span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:#10b981;box-shadow:0 0 10px #10b981;animation:pulse-dot 1.8s infinite;margin-right:6px;"></span>
        Fermer Port (En Écoute...)
      `;
    }
    renderTransmitterPanel('transmitterPanelOpt1');
  } catch (error) {
    showStatus(`Erreur récepteur : ${error.message}`, 'error');
    if (btn) { btn.disabled = false; }
  } finally {
    isReceivingSignal = false;
  }
}

// Alias for backwards compatibility
const receiveSignalFromReceiver = connectOpt1Port;

// Update status pills for Option 1 & Option 3
function updateSignalConfirmStatus() {
  const isOpt3 = currentOption === 3;
  const prefix = isOpt3 ? 'opt3' : 'opt1';

  const statusEl = document.getElementById(`${prefix}-signalStatus`);
  const pill1 = document.getElementById(`${prefix}-pill-1`);
  const pill2 = document.getElementById(`${prefix}-pill-2`);
  const pill3 = document.getElementById(`${prefix}-pill-3`);
  const icon1 = document.getElementById(`${prefix}-icon-1`);
  const icon2 = document.getElementById(`${prefix}-icon-2`);
  const icon3 = document.getElementById(`${prefix}-icon-3`);
  const newInput = document.getElementById(`new-value-input-${prefix}`);

  const setPillState = (pill, icon, state) => {
    if (!pill || !icon) return;
    pill.classList.remove('active', 'success');
    if (state === 'success') {
      pill.classList.add('success');
      icon.innerHTML = `
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="20 6 9 17 4 12"></polyline>
        </svg>
      `;
    } else if (state === 'active') {
      pill.classList.add('active');
      icon.textContent = '●';
    } else {
      icon.textContent = '○';
    }
  };

  if (newValueConfirmed) {
    setPillState(pill1, icon1, 'success');
    setPillState(pill2, icon2, 'success');
    setPillState(pill3, icon3, 'success');
    if (statusEl) {
      statusEl.innerHTML = `<strong style="color: #059669;">VALIDÉ (3/3 MATCH)</strong>`;
    }
    if (newInput) {
      newInput.classList.add('validated');
    }
  } else {
    if (newInput) {
      newInput.classList.remove('validated');
    }

    if (matchingSignalCount === 0) {
      setPillState(pill1, icon1, 'inactive');
      setPillState(pill2, icon2, 'inactive');
      setPillState(pill3, icon3, 'inactive');
      if (statusEl) {
        statusEl.textContent = isOpt3 ? 'Prêt. Cliquez pour acquérir le 1er signal...' : 'En attente du signal...';
      }
    } else if (matchingSignalCount === 1) {
      setPillState(pill1, icon1, 'active');
      setPillState(pill2, icon2, 'inactive');
      setPillState(pill3, icon3, 'inactive');
      if (statusEl) {
        statusEl.innerHTML = `<strong>1/3 Clic</strong> (${pendingHexCode || pendingSignalValue})`;
      }
    } else if (matchingSignalCount === 2) {
      setPillState(pill1, icon1, 'active');
      setPillState(pill2, icon2, 'active');
      setPillState(pill3, icon3, 'inactive');
      if (statusEl) {
        statusEl.innerHTML = `<strong>2/3 Clics</strong> (${pendingHexCode || pendingSignalValue})`;
      }
    }
  }
}



// Update Option 3 Visual Ticket & Print Area
function updateTicketDisplayOption3(hexCode, decId, isConfirmed = false) {
  const displayHex = hexCode || lastConfirmedHexCode || 'FEE7DF';
  const displayDec = decId || lastConfirmedDecId || '—';

  // On-screen Ticket
  const tHex = document.getElementById('ticketOpt3Hex');
  const tDec = document.getElementById('ticketOpt3Dec');
  const btnPrint = document.getElementById('btnPrintTicketOpt3');

  if (tHex) tHex.textContent = displayHex;
  if (tDec) tDec.textContent = displayDec;

  // Enable/disable print button
  if (btnPrint) {
    btnPrint.disabled = !isConfirmed;
  }

  // Render barcodes using JsBarcode (Code128)
  // On-screen: 45mm wide x 25mm tall | Print: smaller, fits 30mm ticket
  const barcodeValue = displayHex;
  const barcodeOptions = {
    format: 'CODE128',
    width: 2,
    height: 70,
    displayValue: true,
    text: barcodeValue,
    fontSize: 11,
    fontOptions: 'bold',
    textMargin: 3,
    margin: 4,
    background: 'transparent',
    lineColor: '#1e1b4b'
  };

  try {
    const ticketSvg = document.getElementById('ticketBarcodeSvg');
    if (ticketSvg && typeof JsBarcode !== 'undefined') {
      ticketSvg.style.width = '140px';
      ticketSvg.style.height = '48px';
      JsBarcode(ticketSvg, barcodeValue, {
        ...barcodeOptions,
        height: 28,
        fontSize: 9,
        margin: 2
      });
      ticketSvg.setAttribute('width', '140');
      ticketSvg.setAttribute('height', '48');
    }
  } catch (e) { /* JsBarcode not loaded yet (offline) */ }

  try {
    const printSvg = document.getElementById('printBarcodeSvg');
    if (printSvg && typeof JsBarcode !== 'undefined') {
      // Print barcode: compact — ~45mm wide (170px) x ~10mm tall bars (38px)
      printSvg.style.width = '150px';
      printSvg.style.height = '52px';
      JsBarcode(printSvg, barcodeValue, {
        ...barcodeOptions,
        width: 1.4,
        height: 32,
        fontSize: 8,
        fontOptions: 'bold',
        textMargin: 2,
        margin: 2,
        lineColor: '#000000',
        background: '#ffffff'
      });
      printSvg.setAttribute('width', '150');
      printSvg.setAttribute('height', '52');
    }
  } catch (e) { /* JsBarcode not loaded yet (offline) */ }

  // Print Area DOM (hex & dec only)
  const pHex = document.getElementById('printHex');
  const pDec = document.getElementById('printDec');
  if (pHex) pHex.textContent = displayHex;
  if (pDec) pDec.textContent = displayDec;
}

// Print Ticket Action
async function printTicket() {
  updateTicketDisplayOption3(lastConfirmedHexCode, lastConfirmedDecId, true);
  showStatus('Impression du ticket en cours...', 'info');

  try {
    const printResult = await ipcRenderer.invoke('print-ticket');
    if (printResult && printResult.success) {
      showStatus('Ticket imprimé avec succès !', 'success');
    } else {
      window.print();
    }
  } catch (err) {
    window.print();
  }
}

// Reset Option 3 for the next scan / ticket
function resetOption3NextClip() {
  // Reset multi-transmitter tracking
  transmitterClickCounts = {};
  transmitterLastCountedAt = {};
  lastActiveTransmitter = null;
  opt3Confirmed = false;

  pendingSignalValue = null;
  pendingHexCode = null;
  matchingSignalCount = 0;
  newValueConfirmed = false;

  updateSignalConfirmStatus();

  const liveHex = document.getElementById('opt3LiveHex');
  const liveDec = document.getElementById('opt3LiveDec');
  if (liveHex) liveHex.textContent = '—';
  if (liveDec) liveDec.textContent = '—';

  // Reset transmitter panel to empty state
  renderTransmitterPanel('transmitterPanel');

  updateTicketDisplayOption3('FEE7DF', '', false);
  showStatus('Réinitialisé. Scannez un émetteur pour commencer.', 'info');
}

// Reset Option 1 transmitter tracking (keep port open)
function resetOpt1Transmitters() {
  transmitterClickCounts = {};
  transmitterLastCountedAt = {};
  lastActiveTransmitter = null;
  opt1Confirmed = false;
  newValueConfirmed = false;

  const inp1 = document.getElementById('new-value-input-opt1');
  if (inp1) inp1.value = '';

  renderTransmitterPanel('transmitterPanelOpt1');
  showStatus('Émetteurs réinitialisés. Scannez à nouveau.', 'info');
}

// Option 1 Manual Save to dbWCT.xml
async function saveChanges() {
  if (!xmlData || !currentFilePath) {
    showStatus('Veuillez vérifier que le fichier XML est chargé', 'error');
    return;
  }
  if (!selectedBoard || !selectedClip) {
    showStatus('Veuillez sélectionner une Planche et un Clip avant d\'enregistrer', 'error');
    return;
  }

  const inp = document.getElementById('new-value-input-opt1');
  const valueToSave = (inp && inp.value ? inp.value.trim() : '') || (newValueConfirmed ? lastConfirmedDecId : '');

  if (!valueToSave || !newValueConfirmed) {
    showStatus('NON OK - Veuillez recevoir un émetteur validé (3 clics) avant d\'enregistrer', 'error');
    return;
  }

  try {
    const boardId = String(selectedBoardData.id[0]);
    if (xmlData.data && xmlData.data.clips && xmlData.data.clips[0] && xmlData.data.clips[0].clip) {
      const clips = xmlData.data.clips[0].clip;
      const clip = clips.find(c => c.name && c.name[0] === selectedClip);
      if (clip) {
        if (!clip.identifiers) clip.identifiers = [{}];
        if (!clip.identifiers[0].board) clip.identifiers[0].board = [];
        const identifier = clip.identifiers[0].board.find(id => id && id.$ && String(id.$.id) === boardId);
        if (identifier) {
          identifier._ = valueToSave;
        } else {
          clip.identifiers[0].board.push({ $: { id: boardId, enabled: 'True' }, _: valueToSave });
        }
      }
    }

    const saveRes = await ipcRenderer.invoke('save-xml', currentFilePath, xmlData);
    if (saveRes && saveRes.success === false) {
      showStatus(`Erreur sauvegarde XML : ${saveRes.message}`, 'error');
      return;
    }

    const ancienVal = document.getElementById('ancienIdValue');
    if (ancienVal) ancienVal.textContent = valueToSave;

    const backupMsg = saveRes && saveRes.backupCreated ? ` (Backup : ${saveRes.backupFileName})` : '';
    showStatus(`✓ Identifiant mis à jour avec succès pour ${selectedClip} sur ${selectedBoard} : ${valueToSave}${backupMsg} !`, 'success');

    // Recharger le XML en arrière-plan pour appliquer les modifications
    const _savedBoard2 = selectedBoard;
    const _savedClip2 = selectedClip;

    // Auto-réinitialisation après sauvegarde pour le prochain émetteur
    transmitterClickCounts = {};
    transmitterLastCountedAt = {};
    lastActiveTransmitter = null;
    opt1Confirmed = false;
    newValueConfirmed = false;
    lastConfirmedDecId = '';
    const inp1 = document.getElementById('new-value-input-opt1');
    if (inp1) inp1.value = '';
    renderTransmitterPanel('transmitterPanelOpt1');

    // Rechargement silencieux du XML pour appliquer les modifications
    await reloadXmlAfterSave(_savedBoard2, _savedClip2);
  } catch (err) {
    showStatus(`Erreur sauvegarde XML : ${err.message}`, 'error');
  }
}

// Toast status notification
let statusTimer = null;
function showStatus(message, type) {
  const statusDiv = document.getElementById('status');
  const statusIcon = document.getElementById('statusIcon');
  const statusMessage = document.getElementById('statusMessage');
  if (!statusDiv || !statusMessage) return;

  if (statusTimer) clearTimeout(statusTimer);

  statusMessage.textContent = message;
  statusDiv.className = `toast-box show status-${type || 'info'}`;

  if (statusIcon) {
    if (type === 'success') statusIcon.innerHTML = ICON_SUCCESS;
    else if (type === 'error') statusIcon.innerHTML = ICON_ERROR;
    else statusIcon.innerHTML = ICON_INFO;
  }

  statusTimer = setTimeout(() => {
    statusDiv.classList.remove('show');
  }, 6500);
}
