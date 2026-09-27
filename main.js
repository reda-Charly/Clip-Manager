const { app, BrowserWindow, ipcMain, shell } = require('electron');
const { exec } = require('child_process');
app.commandLine.appendSwitch('disable-gpu-sandbox');
const path = require('path');
const fs = require('fs');
const xml2js = require('xml2js');
const { SerialPort } = require('serialport');

let mainWindow;
let receiverPort = null;
let configComPort = 'COM1';

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 860,
    height: 780,
    minWidth: 720,
    minHeight: 640,
    backgroundColor: '#f8fafc',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  mainWindow.loadFile('index.html');
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// IPC handlers
ipcMain.handle('load-xml', async (event, filePath) => {
  try {
    const xmlData = fs.readFileSync(filePath, 'utf-8');
    const parser = new xml2js.Parser();
    const result = await parser.parseStringPromise(xmlData);
    
    // Extract COM port from config
    if (result.data && result.data.config && result.data.config[0] && result.data.config[0].comPort) {
      configComPort = result.data.config[0].comPort[0];
    }
    
    return result;
  } catch (error) {
    throw error;
  }
});

ipcMain.handle('save-xml', async (event, filePath, xmlData) => {
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // ── AUTOMATIC BACKUP CREATION & REPLACEMENT ────────────────────────────
    // Create a backup of the existing XML file before saving new modifications.
    // If a backup already exists from a prior save, it is automatically replaced with the current file state.
    let backupCreated = false;
    let backupFileName = '';

    if (fs.existsSync(filePath)) {
      const ext = path.extname(filePath);
      const base = path.basename(filePath, ext);
      const backupPath = path.join(dir, `${base}_backup${ext}`);

      fs.copyFileSync(filePath, backupPath);
      backupCreated = true;
      backupFileName = path.basename(backupPath);
      console.log(`[BACKUP] Backup created / replaced successfully at: ${backupPath}`);
    }

    const builder = new xml2js.Builder({
      renderOpts: { pretty: true, indent: '  ' },
      xmldec: { version: '1.0', encoding: 'UTF-8', standalone: true }
    });
    const xml = builder.buildObject(xmlData);
    fs.writeFileSync(filePath, xml, 'utf-8');

    console.log(`[SAVE] Successfully saved XML to: ${filePath}`);
    return {
      success: true,
      backupCreated,
      backupFileName,
      message: backupCreated
        ? `Enregistré avec succès ! (Backup mis à jour : ${backupFileName})`
        : 'Fichier enregistré avec succès !'
    };
  } catch (error) {
    console.error('[SAVE ERROR]', error);
    return { success: false, message: error.message };
  }
});

// Run / Open XML file handler
ipcMain.handle('run-xml', async (event, filePath) => {
  try {
    const targetPath = filePath || 'C:\\clips\\dbWCT.xml';
    if (!fs.existsSync(targetPath)) {
      console.warn(`[RUN XML] Fichier introuvable à l'emplacement : ${targetPath}`);
      return { success: false, message: `Fichier introuvable : ${targetPath}` };
    }

    console.log(`[RUN XML] Lancement du fichier XML : ${targetPath}`);
    const openErr = await shell.openPath(targetPath);
    if (openErr) {
      console.log(`[RUN XML] shell.openPath retourné : ${openErr}, tentative avec exec start...`);
      exec(`start "" "${targetPath}"`, (err) => {
        if (err) console.error('[RUN XML EXEC ERROR]', err);
      });
    }

    return { success: true, message: `Fichier XML lancé avec succès : ${targetPath}` };
  } catch (error) {
    console.error('[RUN XML ERROR]', error);
    return { success: false, message: error.message };
  }
});

// Serial port communication handlers
ipcMain.handle('get-port-status', async () => {
  return {
    isOpen: receiverPort ? receiverPort.isOpen : false,
    portName: configComPort
  };
});

let serialBuffer = Buffer.alloc(0);
let lastPacketTime = 0;
let silenceTimer = null;

function attachReceiverDataListener(port) {
  if (!port) return;
  
  port.removeAllListeners('data');
  if (silenceTimer) {
    clearTimeout(silenceTimer);
    silenceTimer = null;
  }
  serialBuffer = Buffer.alloc(0);

  port.on('data', (data) => {
    if (silenceTimer) {
      clearTimeout(silenceTimer);
      silenceTimer = null;
    }

    const now = Date.now();
    // Refractory window: ignore repeating packets/bursts from the same button press within 350ms
    if (now - lastPacketTime < 350) {
      serialBuffer = Buffer.alloc(0);
      return;
    }

    serialBuffer = Buffer.concat([serialBuffer, data]);
    console.log('Continuous Data received. Total length:', serialBuffer.length, 'Hex:', serialBuffer.toString('hex').toUpperCase());

    if (serialBuffer.length >= 12) {
      lastPacketTime = Date.now();
      const first12Bytes = serialBuffer.slice(0, 12);
      const middle6Bytes = first12Bytes.slice(6, 12);
      const hexString = middle6Bytes.toString('hex').toUpperCase();

      let hexInput = hexString;
      if (hexInput.startsWith('0X')) {
        hexInput = hexInput.substring(2);
      }
      if (hexInput.length % 2 !== 0) {
        hexInput = '0' + hexInput;
      }

      let decimalOutput = '';
      for (let i = 0; i < hexInput.length; i += 2) {
        const hexByte = hexInput.substring(i, i + 2);
        const decimalValue = parseInt(hexByte, 16);
        decimalOutput += decimalValue.toString().padStart(3, '0');
      }

      if (decimalOutput.length > 12) {
        decimalOutput = decimalOutput.substring(decimalOutput.length - 12);
      }

      let shortHex = hexInput;
      if (shortHex.length > 8) {
        shortHex = shortHex.substring(shortHex.length - 8);
      }

      // Immediately clear buffer so leftover trailing bytes NEVER misalign subsequent button presses
      serialBuffer = Buffer.alloc(0);

      console.log('Emitting signal to renderer:', { hex: shortHex, dec: decimalOutput });

      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('receiver-signal-stream', {
          success: true,
          data: decimalOutput,
          hexCode: shortHex,
          fullHex: hexString
        });
      }
    } else {
      // Incomplete packet: if line is silent for 150ms, flush buffer so fragments never corrupt next click
      silenceTimer = setTimeout(() => {
        serialBuffer = Buffer.alloc(0);
      }, 150);
    }
  });
}

ipcMain.handle('open-receiver-port', async (event) => {
  try {
    // Check if port is already open
    if (receiverPort && receiverPort.isOpen) {
      attachReceiverDataListener(receiverPort);
      return { success: true, message: `Receiver port already open: ${configComPort}` };
    }

    const port = new SerialPort({
      path: configComPort,
      baudRate: 57600,
      dataBits: 8,
      stopBits: 1,
      parity: 'none'
    });

    receiverPort = port;

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Timeout opening port'));
      }, 5000);
      
      port.on('open', () => {
        clearTimeout(timeout);
        resolve();
      });
      
      port.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });

    attachReceiverDataListener(receiverPort);

    return { success: true, message: `Receiver port opened: ${configComPort}` };
  } catch (error) {
    return { success: false, message: error.message };
  }
});

ipcMain.handle('close-receiver-port', async (event) => {
  try {
    if (silenceTimer) {
      clearTimeout(silenceTimer);
      silenceTimer = null;
    }
    lastPacketTime = 0;
    if (receiverPort && receiverPort.isOpen) {
      receiverPort.removeAllListeners('data');
      await receiverPort.close();
      receiverPort = null;
    }
    serialBuffer = Buffer.alloc(0);
    return { success: true, message: 'Receiver port closed successfully' };
  } catch (error) {
    return { success: false, message: error.message };
  }
});

ipcMain.handle('receive-signal', async (event) => {
  try {
    if (!receiverPort || !receiverPort.isOpen) {
      return { success: false, message: 'Receiver port not open' };
    }

    return new Promise((resolve, reject) => {
      let receivedData = Buffer.alloc(0);

      const dataHandler = (data) => {
        receivedData = Buffer.concat([receivedData, data]);
        
        console.log('Data received. Total length:', receivedData.length, 'Hex:', receivedData.toString('hex').toUpperCase());
        
        // Wait for at least 12 bytes, then use first 12 bytes
        if (receivedData.length >= 12) { // At least 12 bytes
          receiverPort.off('data', dataHandler);
          
          // Always use first 12 bytes, take bytes 6-11
          const first12Bytes = receivedData.slice(0, 12);
          const middle6Bytes = first12Bytes.slice(6, 12);
          console.log('First 12 bytes:', first12Bytes.toString('hex').toUpperCase());
          console.log('Middle 6 bytes (positions 6-11):', middle6Bytes.toString('hex').toUpperCase());
          
          // Convert to hex string (same as OGC APP method)
          const hexString = middle6Bytes.toString('hex').toUpperCase();
          
          // Remove 0x prefix if present
          let hexInput = hexString;
          if (hexInput.startsWith('0X')) {
            hexInput = hexInput.substring(2);
          }
          
          // Pad with leading zero if odd length
          if (hexInput.length % 2 !== 0) {
            hexInput = '0' + hexInput;
          }
          
          // Convert each hex byte to decimal and concatenate
          // Pad each decimal value to 3 digits (same as OGC APP)
          let decimalOutput = '';
          for (let i = 0; i < hexInput.length; i += 2) {
            const hexByte = hexInput.substring(i, i + 2);
            const decimalValue = parseInt(hexByte, 16);
            decimalOutput += decimalValue.toString().padStart(3, '0');
          }
          
          // Take last 12 digits to match expected format
          if (decimalOutput.length > 12) {
            decimalOutput = decimalOutput.substring(decimalOutput.length - 12);
          }
          console.log('Final output:', decimalOutput);

          // Extract the hex code (last 8 hex chars / 4 bytes corresponding to 12 decimal digits)
          let shortHex = hexInput;
          if (shortHex.length > 8) {
            shortHex = shortHex.substring(shortHex.length - 8);
          }
          console.log('Short hex code (ticket):', shortHex);
          
          resolve({ success: true, data: decimalOutput, hexCode: shortHex, fullHex: hexString });
        }
      };

      const errorHandler = (error) => {
        receiverPort.off('data', dataHandler);
        receiverPort.off('error', errorHandler);
        reject(error);
      };

      receiverPort.on('data', dataHandler);
      receiverPort.on('error', errorHandler);

      // Timeout after 5 seconds
      setTimeout(() => {
        receiverPort.off('data', dataHandler);
        receiverPort.off('error', errorHandler);
        resolve({ success: false, message: 'Timeout waiting for signal' });
      }, 5000);
    });
  } catch (error) {
    return { success: false, message: error.message };
  }
});

// List serial ports available on the system
ipcMain.handle('list-serial-ports', async () => {
  try {
    const ports = await SerialPort.list();
    const portNames = ports.map(p => p.path);
    return { success: true, ports: portNames };
  } catch (err) {
    return { success: false, ports: [] };
  }
});

// Switch configured COM port
ipcMain.handle('set-com-port', async (event, newPort) => {
  try {
    if (receiverPort && receiverPort.isOpen) {
      receiverPort.removeAllListeners('data');
      await receiverPort.close();
      receiverPort = null;
    }
    serialBuffer = Buffer.alloc(0);
    configComPort = newPort;
    return { success: true, portName: configComPort };
  } catch (err) {
    return { success: false, message: err.message };
  }
});

// Print ticket handler
ipcMain.handle('print-ticket', async (event) => {
  try {
    if (!mainWindow) {
      return { success: false, message: 'Window not available' };
    }
    return new Promise((resolve) => {
      mainWindow.webContents.print({
        silent: false,
        printBackground: true
      }, (success, failureReason) => {
        if (success) {
          resolve({ success: true });
        } else {
          // If user cancelled, failureReason might be 'cancelled'
          resolve({ success: false, message: failureReason || 'Print cancelled or failed' });
        }
      });
    });
  } catch (error) {
    return { success: false, message: error.message };
  }
});
