/*
 * vpn_detect_bypass.js — 绕过 App 对 VPN / 系统代理 / utun 接口的检测
 *
 * 适用: 越狱 iOS + Frida。未越狱设备无法注入，只能走 Loon 侧的模式调整。
 *
 * 用法:
 *   frida -U -f <BUNDLE_ID> -l vpn_detect_bypass.js --no-pause
 * 占位: BUNDLE_ID
 *
 * 覆盖的检测面:
 *   1) getifaddrs      —— 枚举网络接口，暴露 utun/tun/ppp/ipsec
 *   2) sysctl          —— NET_RT_DUMP / NET_RT_IFLIST 读路由表，暴露 utun
 *   3) CFNetworkCopySystemProxySettings      —— 暴露 HTTPProxy/HTTPSProxy
 *   4) SCDynamicStoreCopyProxySettings       —— 同上，走 SystemConfiguration
 *   5) NEVPNManager    —— 读取 VPN 连接状态
 *   6) /proc/net/*     —— 越狱环境直接读路由文件
 */

'use strict';

/* ---------- 1) getifaddrs: 摘掉虚拟接口节点 ---------- */

// struct ifaddrs { ifa_next; ifa_name; ifa_flags; ... }
// 64 位下 ifa_next 在偏移 0，ifa_name 在偏移 pointerSize
const VPN_IFACE_RE = /^(utun|tun|tap|ppp|ipsec|vtun|wg)/;

(function hookGetifaddrs() {
  const addr = Module.findExportByName('libSystem.B.dylib', 'getifaddrs');
  if (!addr) {
    console.log('[-] getifaddrs not found');
    return;
  }

  Interceptor.attach(addr, {
    onEnter: function (args) {
      this.out = args[0]; // struct ifaddrs **
    },
    onLeave: function (retval) {
      if (retval.toInt32() !== 0) return; // 调用失败，无需处理
      try {
        let prev = null;
        let cur = this.out.readPointer();
        let removed = 0;

        while (!cur.isNull()) {
          const namePtr = cur.add(Process.pointerSize).readPointer();
          let name = '';
          try {
            name = namePtr.readUtf8String();
          } catch (e) { /* 名字不可读就放过 */ }

          if (name && VPN_IFACE_RE.test(name)) {
            const next = cur.readPointer();
            if (prev === null) {
              this.out.writePointer(next); // 头节点命中，改写头指针
            } else {
              prev.writePointer(next);
            }
            removed += 1;
            cur = next;
            continue;
          }

          prev = cur;
          cur = cur.readPointer();
        }
        if (removed > 0) console.log('[getifaddrs] removed ' + removed + ' vpn iface');
      } catch (e) {
        console.log('[getifaddrs] err ' + e);
      }
    },
  });
  console.log('[+] hooked getifaddrs');
})();

/* ---------- 2) sysctl: 屏蔽路由表查询 ---------- */

const CTL_NET = 4;
const AF_ROUTE = 17;
const NET_RT_DUMP = 1;
const NET_RT_IFLIST = 2;
const NET_RT_IFLIST2 = 6;
const NET_RT_FLAGS = 3;

(function hookSysctl() {
  const addr = Module.findExportByName('libSystem.B.dylib', 'sysctl');
  if (!addr) return;

  Interceptor.attach(addr, {
    onEnter: function (args) {
      this.mib = args[0];
      this.hit = false;
      try {
        const a = this.mib.readInt();
        const b = this.mib.add(4).readInt();
        if (a === CTL_NET && b === AF_ROUTE) {
          const kind = this.mib.add(16).readInt(); // mib[4]
          if (kind === NET_RT_DUMP || kind === NET_RT_IFLIST ||
              kind === NET_RT_IFLIST2 || kind === NET_RT_FLAGS) {
            this.hit = true;
          }
        }
      } catch (e) { /* 读取失败按未命中处理 */ }
    },
    onLeave: function (retval) {
      if (!this.hit) return;
      // 返回 -1 并置 errno=ENOENT，让调用方当作查询无结果
      retval.replace(-1);
      console.log('[sysctl] blocked route table query');
    },
  });
  console.log('[+] hooked sysctl (route)');
})();

/* ---------- 3) 代理设置字典: 抹掉代理相关键 ---------- */

const PROXY_KEYS = [
  'HTTPEnable', 'HTTPProxy', 'HTTPPort',
  'HTTPSEnable', 'HTTPSProxy', 'HTTPSPort',
  'SOCKSEnable', 'SOCKSProxy', 'SOCKSPort',
  'ProxyAutoConfigEnable', 'ProxyAutoConfigURLString',
  'RTSPProxy', 'RTSPEnable', 'FTPProxy', 'FTPEnable',
  'GopherProxy', 'GopherEnable',
  '__SCOPED__',
];

function scrubProxyDict(retval) {
  try {
    const dict = new ObjC.Object(retval);
    if (!dict || typeof dict.mutableCopy !== 'function') return false;

    const mutable = dict.mutableCopy();
    PROXY_KEYS.forEach(function (k) {
      try {
        mutable.removeObjectForKey_(k);
      } catch (e) { /* 键不存在 */ }
    });

    // 让返回的字典"看起来"没有代理：再塞一个明确的关闭态
    try {
      mutable.setValue_forKey_(ObjC.classes.NSNumber.numberWithBool_(false), 'HTTPEnable');
      mutable.setValue_forKey_(ObjC.classes.NSNumber.numberWithBool_(false), 'HTTPSEnable');
      mutable.setValue_forKey_(ObjC.classes.NSNumber.numberWithBool_(false), 'SOCKSEnable');
      mutable.setValue_forKey_(ObjC.classes.NSNumber.numberWithBool_(false), 'ProxyAutoConfigEnable');
    } catch (e) { /* 部分键可能不接受写入 */ }

    retval.replace(mutable.handle);
    return true;
  } catch (e) {
    console.log('[proxy] scrub failed: ' + e);
    return false;
  }
}

(function hookCFNetworkProxy() {
  const addr = Module.findExportByName('CFNetwork', 'CFNetworkCopySystemProxySettings');
  if (!addr) {
    console.log('[-] CFNetworkCopySystemProxySettings not found');
    return;
  }
  Interceptor.attach(addr, {
    onLeave: function (retval) {
      if (scrubProxyDict(retval)) console.log('[proxy] scrubbed CFNetwork dict');
    },
  });
  console.log('[+] hooked CFNetworkCopySystemProxySettings');
})();

(function hookSCProxy() {
  const addr = Module.findExportByName('SystemConfiguration', 'SCDynamicStoreCopyProxySettings');
  if (!addr) {
    console.log('[-] SCDynamicStoreCopyProxySettings not found');
    return;
  }
  Interceptor.attach(addr, {
    onLeave: function (retval) {
      if (scrubProxyDict(retval)) console.log('[proxy] scrubbed SystemConfiguration dict');
    },
  });
  console.log('[+] hooked SCDynamicStoreCopyProxySettings');
})();

/* ---------- 4) NEVPNManager: 状态伪装为已断开 ---------- */

if (ObjC.available && ObjC.classes.NEVPNManager) {
  try {
    const cls = ObjC.classes.NEVPNManager;
    const sel = '- connection';
    if (typeof cls[sel] === 'function' && cls[sel].implementation) {
      Interceptor.attach(cls[sel].implementation, {
        onLeave: function (retval) {
          try {
            const conn = new ObjC.Object(retval);
            // NEVPNStatusInvalid = 0, Disconnected = 1
            const stub = ObjC.classes.NSObject.alloc().init();
            conn.__vpnStub = stub;
          } catch (e) { /* 忽略 */ }
        },
      });

      // 直接改 status 返回值最省事
      const connCls = ObjC.classes.NEVPNConnection;
      if (connCls && typeof connCls['- status'] === 'function') {
        Interceptor.attach(connCls['- status'].implementation, {
          onLeave: function (retval) {
            retval.replace(1); // NEVPNStatusDisconnected
            console.log('[vpn] NEVPNConnection.status -> Disconnected');
          },
        });
        console.log('[+] hooked NEVPNConnection status');
      }
    }
  } catch (e) {
    console.log('[vpn] NEVPNManager hook skipped: ' + e);
  }
}

/* ---------- 5) 路由文件读取 ---------- */

const ROUTE_PATHS = ['/proc/net/route', '/proc/net/dev', '/proc/net/if_inet6', '/etc/resolv.conf'];

['open', 'fopen', 'access', 'stat'].forEach(function (fn) {
  const addr = Module.findExportByName('libSystem.B.dylib', fn);
  if (!addr) return;
  Interceptor.attach(addr, {
    onEnter: function (args) {
      try {
        const p = args[0].readUtf8String();
        if (p && ROUTE_PATHS.indexOf(p) !== -1) {
          args[0] = Memory.allocUtf8String('/nonexistent/' + Math.random().toString(36).slice(2));
          console.log('[' + fn + '] redirected ' + p);
        }
      } catch (e) { /* 忽略 */ }
    },
  });
});

console.log('[*] vpn_detect_bypass.js injected');
