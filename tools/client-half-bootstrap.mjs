/**
 * Bootstrap that runs the plugin's GUI half inside a real DSH page.
 *
 * Shared by the end-to-end lane (which asserts the chip's behaviour) and the
 * screenshot lane (which photographs it), so both drive the same shipped
 * `lib/client.js` the same way.
 *
 * The GUI module loader only *records* a module; the DSH runtime is what calls
 * `apply`. So the bootstrap waits for `window.__ModuleLoader__`, wraps its
 * `load` to capture our spec, evaluates the shipped client source verbatim, and
 * exposes a `mount(ctx)` the caller can drive with a minimal `ctx.effect`.
 *
 * Status machine: waiting → ready (source evaluated, spec captured) → mounted
 * (apply ran), or spec-missing / load-failed / no-loader.
 *
 * @param {string} clientSource - the contents of `lib/client.js`.
 * @returns {string} a self-contained script for `addInitScript`.
 */
export function clientHalfBootstrap(clientSource) {
  return [
    '(function () {',
    '  var mounted = null;',
    '  window.__dshTabGroupsTest = {',
    '    status: "waiting",',
    '    error: null,',
    '    mount: function (ctx) {',
    '      try {',
    '        if (mounted) return "already";',
    '        if (!window.__capturedSpec) return "no-spec";',
    '        var mod = window.__capturedSpec.factory();',
    '        mod.apply(ctx);',
    '        mounted = mod;',
    '        this.status = "mounted";',
    '        return "mounted";',
    '      } catch (e) {',
    '        this.status = "failed";',
    '        this.error = String((e && e.message) || e);',
    '        return this.error;',
    '      }',
    '    }',
    '  };',
    '  var tries = 0;',
    '  var timer = setInterval(function () {',
    '    tries++;',
    '    if (window.__ModuleLoader__ && typeof window.__ModuleLoader__.load === "function") {',
    '      clearInterval(timer);',
    '      var original = window.__ModuleLoader__.load.bind(window.__ModuleLoader__);',
    '      window.__ModuleLoader__.load = function (spec) {',
    '        if (spec && spec.id === "dsh-tab-groups") window.__capturedSpec = spec;',
    '        return original(spec);',
    '      };',
    '      try {',
    clientSource,
    '        window.__dshTabGroupsTest.status = window.__capturedSpec ? "ready" : "spec-missing";',
    '      } catch (e) {',
    '        window.__dshTabGroupsTest.status = "load-failed";',
    '        window.__dshTabGroupsTest.error = String((e && e.message) || e);',
    '      }',
    '      return;',
    '    }',
    '    if (tries > 400) { clearInterval(timer); window.__dshTabGroupsTest.status = "no-loader"; }',
    '  }, 25);',
    '})();',
  ].join('\n')
}
