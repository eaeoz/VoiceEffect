const { execSync, exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const os = require('os');
const EventEmitter = require('events');

const VB_CABLE_URL = 'https://download.vb-audio.com/Download_CABLE/VBCABLE_Driver_Pack45.zip';
const VBCABLE_NAME = 'VB-Audio Virtual Cable';
const VBCABLE_DEVICE_PATTERN = /VB-Audio|VBCABLE|Virtual Cable/i;

class VirtualAudioAdapter extends EventEmitter {
  constructor() {
    super();
    this._installed = false;
    this._installing = false;
    this._driverPath = null;
    this._tempDir = path.join(os.tmpdir(), 'voiceeffect-vbcable');
  }

  isInstalled() {
    return this._installed;
  }

  async checkInstalled() {
    try {
      const result = execSync(
        'powershell -Command "Get-PnpDevice -Class \'AudioEndpoint\' | Where-Object { $_.FriendlyName -match \'VB-Audio|VBCABLE|Virtual Cable\' } | Select-Object -ExpandProperty FriendlyName"',
        { encoding: 'utf-8', timeout: 10000 }
      );
      if (result.trim().length > 0) {
        this._installed = true;
        this.emit('status', { installed: true });
        return true;
      }
    } catch (e) {}

    if (this._findInstallPath()) {
      this._installed = true;
      this.emit('status', { installed: true });
      return true;
    }

    this._installed = false;
    this.emit('status', { installed: false });
    return false;
  }

  async checkAudioServices() {
    try {
      const result = execSync(
        'powershell -Command "Get-Service -Name \'VBAudioCable\' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Status"',
        { encoding: 'utf-8', timeout: 5000 }
      );
      return result.trim() === 'Running';
    } catch (e) {
      return false;
    }
  }

  async install(progressCallback) {
    if (this._installed) return { success: true, message: 'Already installed' };
    if (this._installing) return { success: false, message: 'Installation already in progress' };

    this._installing = true;
    this.emit('installing', true);

    try {
      if (progressCallback) progressCallback({ stage: 'downloading', percent: 0 });

      if (!fs.existsSync(this._tempDir)) {
        fs.mkdirSync(this._tempDir, { recursive: true });
      }

      const zipPath = path.join(this._tempDir, 'VBCable.zip');
      const extractDir = path.join(this._tempDir, 'VBCable');

      await this._downloadFile(VB_CABLE_URL, zipPath, (percent) => {
        if (progressCallback) progressCallback({ stage: 'downloading', percent });
      });

      if (progressCallback) progressCallback({ stage: 'extracting', percent: 0 });

      await this._extractZip(zipPath, extractDir);

      if (progressCallback) progressCallback({ stage: 'installing', percent: 0 });

      const setupPath = this._findSetupExe(extractDir);
      if (!setupPath) {
        throw new Error('Setup file not found after extraction');
      }

      await this._runInstaller(setupPath);

      this._cleanupTemp();

      await new Promise(r => setTimeout(r, 2000));

      const verified = this._findInstallPath() !== null;
      if (!verified) {
        throw new Error('Installer completed but VB-Cable files not found. Try running the installer manually as Administrator.');
      }

      this._installed = true;
      this.emit('status', { installed: true });

      if (progressCallback) progressCallback({ stage: 'complete', percent: 100 });

      return { success: true, message: 'Installed. Please reboot your computer for the device to appear.' };
    } catch (e) {
      this.emit('error', e.message);
      return { success: false, error: e.message };
    } finally {
      this._installing = false;
      this.emit('installing', false);
    }
  }

  async uninstall() {
    if (!this._installed) return { success: true, message: 'Not installed' };

    try {
      const setupPath = this._findUninstallPath();
      if (setupPath) {
        const isSetupExe = setupPath.toLowerCase().includes('setup');
        if (isSetupExe) {
          await this._runSetupUninstall(setupPath);
        } else {
          await this._runUninstaller(setupPath);
        }
      } else {
        execSync(
          'powershell -Command "Get-WmiObject -Class Win32_Product | Where-Object { $_.Name -match \'VB-Audio Virtual Cable\' } | ForEach-Object { $_.Uninstall() }"',
          { encoding: 'utf-8', timeout: 60000 }
        );
      }

      this._installed = false;
      this.emit('status', { installed: false });

      return { success: true, message: 'Uninstalled. Please reboot your computer.' };
    } catch (e) {
      this.emit('error', e.message);
      return { success: false, error: e.message };
    }
  }

  _findUninstallPath() {
    try {
      const uninstallPaths = [
        path.join(process.env['ProgramFiles(x86)'] || '', 'VB', 'CABLE', 'VBCABLE_Uninstall.exe'),
        path.join(process.env['ProgramFiles'] || '', 'VB', 'CABLE', 'VBCABLE_Uninstall.exe'),
        path.join(process.env['ProgramFiles(x86)'] || '', 'VB', 'CABLE', 'unins000.exe'),
        path.join(process.env['ProgramFiles'] || '', 'VB', 'CABLE', 'unins000.exe'),
      ];

      for (const p of uninstallPaths) {
        if (fs.existsSync(p)) return p;
      }

      const registry = execSync(
        'reg query "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall" /s /f "VB-Audio" /d',
        { encoding: 'utf-8', timeout: 5000 }
      );
      const match = registry.match(/UninstallString\s+REG_SZ\s+(.+)/i);
      if (match) return match[1].trim();
    } catch (e) {}

    const installPath = this._findInstallPath();
    if (installPath) {
      const is64Bit = process.arch === 'x64' || process.env.PROCESSOR_ARCHITECTURE === 'AMD64';
      const setupNames = is64Bit
        ? ['VBCABLE_Setup_x64.exe', 'VBCABLE_Setup.exe']
        : ['VBCABLE_Setup.exe', 'VBCABLE_Setup_x64.exe'];
      for (const name of setupNames) {
        const p = path.join(installPath, name);
        if (fs.existsSync(p)) return p;
      }
    }

    return null;
  }

  _findInstallPath() {
    const installDirs = [
      path.join(process.env['ProgramFiles'] || '', 'VB', 'CABLE'),
      path.join(process.env['ProgramFiles(x86)'] || '', 'VB', 'CABLE'),
    ];
    for (const dir of installDirs) {
      if (fs.existsSync(dir) && fs.existsSync(path.join(dir, 'VBCABLE_ControlPanel.exe'))) {
        return dir;
      }
    }
    return null;
  }

  _downloadFile(url, dest, progressCallback) {
    return new Promise((resolve, reject) => {
      const file = fs.createWriteStream(dest);
      let downloadedBytes = 0;
      let totalBytes = 0;

      const protocol = url.startsWith('https') ? https : http;

      const request = protocol.get(url, { timeout: 120000 }, (response) => {
        if (response.statusCode === 301 || response.statusCode === 302) {
          file.close();
          fs.unlinkSync(dest);
          return this._downloadFile(response.headers.location, dest, progressCallback).then(resolve).catch(reject);
        }

        if (response.statusCode !== 200) {
          file.close();
          fs.unlinkSync(dest);
          return reject(new Error(`Download failed with status ${response.statusCode}`));
        }

        totalBytes = parseInt(response.headers['content-length'], 10) || 0;

        response.on('data', (chunk) => {
          downloadedBytes += chunk.length;
          if (totalBytes > 0 && progressCallback) {
            progressCallback(Math.round((downloadedBytes / totalBytes) * 100));
          }
        });

        response.pipe(file);

        file.on('finish', () => {
          file.close(resolve);
        });
      });

      request.on('error', (err) => {
        file.close();
        if (fs.existsSync(dest)) fs.unlinkSync(dest);
        reject(err);
      });

      request.on('timeout', () => {
        request.destroy();
        file.close();
        if (fs.existsSync(dest)) fs.unlinkSync(dest);
        reject(new Error('Download timed out'));
      });
    });
  }

  _extractZip(zipPath, destDir) {
    return new Promise((resolve, reject) => {
      try {
        if (fs.existsSync(destDir)) {
          fs.rmSync(destDir, { recursive: true, force: true });
        }
        fs.mkdirSync(destDir, { recursive: true });

        execSync(
          `powershell -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${destDir}' -Force"`,
          { encoding: 'utf-8', timeout: 30000 }
        );
        resolve();
      } catch (e) {
        reject(new Error('Failed to extract: ' + e.message));
      }
    });
  }

  _findSetupExe(dir) {
    const is64Bit = process.arch === 'x64' || process.env.PROCESSOR_ARCHITECTURE === 'AMD64';
    const names = is64Bit
      ? ['VBCABLE_Setup_x64.exe', 'VBCABLE_Setup.exe', 'VBCableSetup.exe', 'setup.exe', 'Setup.exe']
      : ['VBCABLE_Setup.exe', 'VBCABLE_Setup_x64.exe', 'VBCableSetup.exe', 'setup.exe', 'Setup.exe'];
    for (const name of names) {
      const p = path.join(dir, name);
      if (fs.existsSync(p)) return p;
    }
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const found = this._findSetupExe(path.join(dir, entry.name));
          if (found) return found;
        } else if (entry.name.toLowerCase().endsWith('.exe')) {
          return path.join(dir, entry.name);
        }
      }
    } catch (e) {}
    return null;
  }

  _runInstaller(setupPath) {
    return new Promise((resolve, reject) => {
      const cmd = `powershell -Command "Start-Process -FilePath '${setupPath}' -Verb RunAs -Wait"`;
      exec(cmd, { timeout: 300000 }, (error, stdout, stderr) => {
        if (error) {
          reject(new Error('Installer failed (UAC may have been cancelled): ' + (stderr || error.message)));
        } else {
          resolve();
        }
      });
    });
  }

  _runUninstaller(uninstallPath) {
    return new Promise((resolve, reject) => {
      const cmd = `powershell -Command "Start-Process -FilePath '${uninstallPath}' -ArgumentList '/SILENT' -Verb RunAs -Wait"`;
      exec(cmd, { timeout: 120000 }, (error, stdout, stderr) => {
        if (error) {
          reject(new Error('Uninstaller failed: ' + (stderr || error.message)));
        } else {
          resolve();
        }
      });
    });
  }

  _runSetupUninstall(setupPath) {
    return new Promise((resolve, reject) => {
      const cmd = `powershell -Command "Start-Process -FilePath '${setupPath}' -ArgumentList '/Uninstall' -Verb RunAs -Wait"`;
      exec(cmd, { timeout: 300000 }, (error, stdout, stderr) => {
        if (error) {
          reject(new Error('Uninstaller failed: ' + (stderr || error.message)));
        } else {
          resolve();
        }
      });
    });
  }

  _waitForDevice(timeout) {
    return new Promise((resolve, reject) => {
      const startTime = Date.now();
      const check = () => {
        this.checkInstalled().then(found => {
          if (found) return resolve();
          if (Date.now() - startTime > timeout) {
            return reject(new Error('Timeout waiting for device'));
          }
          setTimeout(check, 1000);
        }).catch(reject);
      };
      check();
    });
  }

  _waitForDeviceRemoval(timeout) {
    return new Promise((resolve, reject) => {
      const startTime = Date.now();
      const check = () => {
        this.checkInstalled().then(found => {
          if (!found) return resolve();
          if (Date.now() - startTime > timeout) {
            return reject(new Error('Timeout waiting for device removal'));
          }
          setTimeout(check, 1000);
        }).catch(reject);
      };
      check();
    });
  }

  _cleanupTemp() {
    try {
      if (fs.existsSync(this._tempDir)) {
        fs.rmSync(this._tempDir, { recursive: true, force: true });
      }
    } catch (e) {}
  }

  getDeviceInfo() {
    try {
      const result = execSync(
        'powershell -Command "Get-PnpDevice -Class \'AudioEndpoint\' | Where-Object { $_.FriendlyName -match \'VB-Audio|VBCABLE|Virtual Cable\' } | Select-Object FriendlyName, InstanceId, Status | ConvertTo-Json"',
        { encoding: 'utf-8', timeout: 10000 }
      );
      const devices = JSON.parse(result);
      return Array.isArray(devices) ? devices : [devices];
    } catch (e) {
      return [];
    }
  }
}

module.exports = new VirtualAudioAdapter();
