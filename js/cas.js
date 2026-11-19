// Exact symbolic math with SymPy, running in the browser through Pyodide (loaded on first use).
import { settings } from './settings.js';

let pyPromise = null;

const PRELUDE = `
import sys, io, json
from sympy import *
from sympy.vector import CoordSys3D, curl, divergence, gradient, Del
N = CoordSys3D('N')
x, y, z, t = symbols('x y z t', real=True)
`;

const RUNNER = `
_buf = io.StringIO()
_old = sys.stdout
sys.stdout = _buf
_err = None
_ns = dict(globals())
try:
    exec(__code, _ns)
except Exception:
    import traceback
    _err = traceback.format_exc(limit=2)
finally:
    sys.stdout = _old
_res = _ns.get('result', None)
_lat = ''
if _res is not None:
    try:
        _lat = latex(_res)
    except Exception:
        _lat = ''
json.dumps({'stdout': _buf.getvalue()[-6000:], 'result': (str(_res)[:4000] if _res is not None else None), 'latex': _lat[:4000], 'error': _err})
`;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error('Could not load ' + src));
    document.head.appendChild(s);
  });
}

async function load() {
  if (!pyPromise) {
    pyPromise = (async () => {
      if (!window.loadPyodide) await loadScript(settings.pyodideUrl + 'pyodide.js');
      const py = await window.loadPyodide({ indexURL: settings.pyodideUrl });
      await py.loadPackage('sympy');
      await py.runPythonAsync(PRELUDE);
      return py;
    })();
    pyPromise.catch(() => { pyPromise = null; });
  }
  return pyPromise;
}

export async function runSympy(code) {
  const py = await load();
  py.globals.set('__code', code);
  const out = await py.runPythonAsync(RUNNER);
  return JSON.parse(out);
}

export function warmCas() {
  load().catch(() => {});
}
