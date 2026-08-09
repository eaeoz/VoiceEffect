const { execFile, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const SCRIPT_NAME = 'system-audio-routing.ps1';

function getScriptPath() {
  return path.join(os.tmpdir(), 'voiceeffect', SCRIPT_NAME);
}

function ensureScript() {
  const dir = path.join(os.tmpdir(), 'voiceeffect');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const scriptPath = getScriptPath();
  fs.writeFileSync(scriptPath, PS_SCRIPT, 'utf-8');
  return scriptPath;
}

function run(args, timeout) {
  return new Promise((resolve, reject) => {
    const scriptPath = ensureScript();
    const cmdArgs = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath].concat(args);
    execFile('powershell', cmdArgs, { timeout: timeout || 30000, windowsHide: true, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error((stderr || '').trim() || error.message));
        return;
      }
      const text = (stdout || '').trim();
      try {
        resolve(JSON.parse(text));
      } catch (e) {
        reject(new Error('Invalid output from audio router: ' + text.slice(0, 200)));
      }
    });
  });
}

let currentOverride = null;
let dataFile = null;

function init(dataDir) {
  dataFile = path.join(dataDir, 'system-audio-override.json');
}

function persistOverride() {
  if (!dataFile || !currentOverride || !currentOverride.id) return;
  try { fs.writeFileSync(dataFile, JSON.stringify({ id: currentOverride.id }), 'utf-8'); } catch (e) {}
}

function clearOverrideFile() {
  if (!dataFile) return;
  try { if (fs.existsSync(dataFile)) fs.unlinkSync(dataFile); } catch (e) {}
}

async function restorePendingOnStart() {
  if (!dataFile || !fs.existsSync(dataFile)) return;
  let id = null;
  try { id = JSON.parse(fs.readFileSync(dataFile, 'utf-8')).id; } catch (e) {}
  clearOverrideFile();
  if (id) {
    try { await run(['set-default-by-id', id], 15000); } catch (e) {}
  }
}

async function getOutputs() {
  const res = await run(['get-devices']);
  if (!res.ok) throw new Error(res.error || 'Failed to list output devices');
  return res.devices || [];
}

async function getDefaultOutput() {
  const res = await run(['get-default']);
  if (!res.ok) throw new Error(res.error || 'Failed to get default output');
  return res.data || { name: '', id: '' };
}

async function setDefaultOutput(name) {
  if (currentOverride === null) {
    try { currentOverride = await getDefaultOutput(); } catch (e) { currentOverride = { name: '', id: '' }; }
  }
  const res = await run(['set-default', name]);
  if (!res.ok) throw new Error(res.error || 'Failed to set default output');
  return res.data || {};
}

function restoreDefaultOutputSync() {
  if (!currentOverride || !currentOverride.id) return;
  try {
    const scriptPath = ensureScript();
    execSync(
      'powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + scriptPath + '" set-default-by-id "' + currentOverride.id + '"',
      { timeout: 10000, windowsHide: true }
    );
  } catch (e) {}
  currentOverride = null;
  clearOverrideFile();
}

async function restoreDefaultOutput() {
  if (!currentOverride) return;
  try {
    const res = await run(['set-default-by-id', currentOverride.id]);
    return res.ok;
  } catch (e) {
    return false;
  } finally {
    currentOverride = null;
    clearOverrideFile();
  }
}

const PS_SCRIPT = String.raw`$ErrorActionPreference = 'Stop'
$code = @'
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Collections.Generic;

public static class AudioHelper {
  const int eRender = 0;
  const int eConsole = 0, eMultimedia = 1, eCommunications = 2;
  const int DEVICE_STATE_ACTIVE = 1;
  static readonly Guid FRIENDLY_NAME_KEY = new Guid("a45c254e-df1c-4efd-8020-67d146a850e0");

  [StructLayout(LayoutKind.Sequential)]
  public struct PROPVARIANT {
    public ushort vt;
    public ushort wReserved1;
    public ushort wReserved2;
    public ushort wReserved3;
    public IntPtr p;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct PROPERTYKEY {
    public Guid fmtid;
    public uint pid;
  }

  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
  class MMDeviceEnumeratorComObject { }

  [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDeviceEnumerator {
    int EnumAudioEndpoints(int dataFlow, int dwStateMask, out IMMDeviceCollection ppDevices);
    int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice ppEndpoint);
    int GetDevice(string pwstrId, out IMMDevice ppDevice);
    int RegisterEndpointNotificationCallback([MarshalAs(UnmanagedType.IUnknown)] object pClient);
    int UnregisterEndpointNotificationCallback([MarshalAs(UnmanagedType.IUnknown)] object pClient);
  }

  [Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDeviceCollection {
    int GetCount(out int pcDevices);
    int Item(int nDevice, out IMMDevice ppDevice);
  }

  [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDevice {
    int Activate(ref Guid iid, int dwClsCtx, IntPtr pActivationParams, [MarshalAs(UnmanagedType.IUnknown)] out object ppInterface);
    int OpenPropertyStore(int stgmAccess, out IPropertyStore ppProperties);
    int GetId([MarshalAs(UnmanagedType.LPWStr)] out string ppstrId);
    int GetState(out int pdwState);
  }

  [Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IPropertyStore {
    int GetCount(out int cProps);
    int GetAt(int iProp, out PROPERTYKEY pkey);
    int GetValue(ref PROPERTYKEY key, out PROPVARIANT pv);
    int SetValue(ref PROPERTYKEY key, ref PROPVARIANT pv);
    int Commit();
  }

  [Guid("F8679F50-850A-41CF-9C72-430F290290C8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IPolicyConfig {
    int GetMixFormat(string pszDeviceName, IntPtr ppFormat);
    int GetDeviceFormat(string pszDeviceName, int bDefault, IntPtr ppFormat);
    int ResetDeviceFormat(string pszDeviceName);
    int SetDeviceFormat(string pszDeviceName, int bDefault, IntPtr pEndpointFormat, IntPtr mixFormat);
    int GetProcessingPeriod(string pszDeviceName, int bDefault, IntPtr pmftDefaultPeriod, IntPtr pmftMinimumPeriod);
    int SetProcessingPeriod(string pszDeviceName, IntPtr pmftPeriod);
    int GetShareMode(string pszDeviceName, IntPtr pMode);
    int SetShareMode(string pszDeviceName, IntPtr mode);
    int GetPropertyValue(string pszDeviceName, int bFxStore, IntPtr key, IntPtr pv);
    int SetPropertyValue(string pszDeviceName, int bFxStore, IntPtr key, IntPtr pv);
    int SetDefaultEndpoint(string pszDeviceName, int role);
    int SetEndpointVisibility(string pszDeviceName, int bVisible);
  }

  [ComImport, Guid("870af99c-171d-4f9e-af0d-e63df40c2bc9")]
  class PolicyConfigClient { }

  static string GetDeviceName(IMMDevice dev) {
    try {
      IPropertyStore store;
      if (dev.OpenPropertyStore(0, out store) != 0) return "";
      PROPERTYKEY key;
      key.fmtid = FRIENDLY_NAME_KEY;
      key.pid = 14;
      PROPVARIANT val;
      if (store.GetValue(ref key, out val) != 0) return "";
      if (val.vt == 31) {
        string s = Marshal.PtrToStringUni(val.p);
        return s ?? "";
      }
      return "";
    } catch { return ""; }
  }

  static string GetDeviceId(IMMDevice dev) {
    try {
      string id;
      return dev.GetId(out id) == 0 ? id : "";
    } catch { return ""; }
  }

  public static string[] GetDevices() {
    var list = new List<string>();
    var enumerator = (IMMDeviceEnumerator)new MMDeviceEnumeratorComObject();
    IMMDeviceCollection coll;
    if (enumerator.EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE, out coll) != 0) return list.ToArray();
    int count;
    coll.GetCount(out count);
    for (int i = 0; i < count; i++) {
      IMMDevice dev;
      coll.Item(i, out dev);
      string id = GetDeviceId(dev);
      string name = GetDeviceName(dev);
      list.Add(name + "|" + id);
    }
    return list.ToArray();
  }

  public static string GetDefault() {
    var enumerator = (IMMDeviceEnumerator)new MMDeviceEnumeratorComObject();
    IMMDevice dev;
    if (enumerator.GetDefaultAudioEndpoint(eRender, eConsole, out dev) != 0) return "";
    string id = GetDeviceId(dev);
    string name = GetDeviceName(dev);
    return name + "|" + id;
  }

  public static int SetDefaultById(string deviceId) {
    var pcc = (IPolicyConfig)new PolicyConfigClient();
    int hr = pcc.SetDefaultEndpoint(deviceId, eConsole);
    if (hr == 0) pcc.SetDefaultEndpoint(deviceId, eMultimedia);
    if (hr == 0) pcc.SetDefaultEndpoint(deviceId, eCommunications);
    return hr;
  }
}
'@

Add-Type -TypeDefinition $code -Language CSharp

function Emit($obj) {
  [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress -Depth 5))
}

try {
  $mode = $args[0]
  switch ($mode) {
    'get-devices' {
      $devices = [AudioHelper]::GetDevices()
      $list = @()
      foreach ($d in $devices) {
        $parts = $d -split '\|', 2
        $list += @{ name = $parts[0]; id = $parts[1] }
      }
      Emit @{ ok = $true; devices = $list }
      break
    }
    'get-default' {
      $cur = [AudioHelper]::GetDefault()
      $parts = $cur -split '\|', 2
      Emit @{ ok = $true; data = @{ name = $parts[0]; id = $parts[1] } }
      break
    }
    'set-default' {
      $targetName = $args[1]
      $devices = [AudioHelper]::GetDevices()
      $match = $null
      foreach ($d in $devices) {
        $parts = $d -split '\|', 2
        if ($parts[0] -eq $targetName) { $match = $parts; break }
      }
      if (-not $match) {
        foreach ($d in $devices) {
          $parts = $d -split '\|', 2
          if ($parts[0] -match [regex]::Escape($targetName)) { $match = $parts; break }
        }
      }
      if (-not $match) {
        Emit @{ ok = $false; error = 'Device not found: ' + $targetName }
        break
      }
      $before = [AudioHelper]::GetDefault()
      $hr = [AudioHelper]::SetDefaultById($match[1])
      if ($hr -ne 0) {
        Emit @{ ok = $false; error = ('SetDefaultEndpoint failed: 0x{0:X8}' -f $hr) }
        break
      }
      $bparts = $before -split '\|', 2
      Emit @{ ok = $true; data = @{ name = $match[0]; id = $match[1]; previous = @{ name = $bparts[0]; id = $bparts[1] } } }
      break
    }
    'set-default-by-id' {
      $targetId = $args[1]
      $hr = [AudioHelper]::SetDefaultById($targetId)
      if ($hr -ne 0) {
        Emit @{ ok = $false; error = ('SetDefaultEndpoint failed: 0x{0:X8}' -f $hr) }
      } else {
        Emit @{ ok = $true }
      }
      break
    }
    default {
      Emit @{ ok = $false; error = 'Unknown mode: ' + $mode }
    }
  }
} catch {
  Emit @{ ok = $false; error = $_.Exception.Message }
}
`;

module.exports = {
  init,
  getOutputs,
  getDefaultOutput,
  setDefaultOutput,
  restoreDefaultOutput,
  restoreDefaultOutputSync,
  restorePendingOnStart,
  persistOverride,
  clearOverrideFile,
  get currentOverride() { return currentOverride; }
};
