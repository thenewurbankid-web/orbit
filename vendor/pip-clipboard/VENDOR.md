# pip-clipboard (vendored)

- Source: local repository `pip-clipboard`, commit `ce33800` (2026-10-04), v0.1.0, MIT (see LICENSE).
- What: the `src/` ES modules exactly as committed (`git archive ce33800 src LICENSE`). Orbit loads
  `src/pip-clipboard.js` from this folder (`../../clipboard.js`); no CDN, no build step.
- SHA-256 per file:

```
0cdb1c0af60b2e6865c382e27de9bff56668cbed799731c32ef34f991783b9e3  src/detect.js
970ee0116348762ae03842b7978f0ec868e4bc55ef82a6118fb036db7316d944  src/emitter.js
75e618cf245f28dc06325473b035bfd5ce175e2278e1920293e9b493daa1ace8  src/helpers.js
ba50510c6ea14c704421cd69c6d4149d99f90918e21af06af932a93b334ef3c8  src/icons.js
29ab6b6e7968812854b4edff48aa5e6024a7b63713e5c533f0dfb5b1a28077c2  src/link-meta.js
cbe635b921e0e01837175f06bb2e5c1706e332e659d9259344dcffdcb7ecdd57  src/normalize.js
82b9de4aa78258926d04ba4b57c01941d779b51df17434c088b049bb020c9874  src/pip-clipboard.js
ac30e7fee4e7da818193e3ad6c0e55bd22099078c21b63f0d64ebb8cb3724d47  src/registry.js
123255381c0d4319b6f320f4b4b8d2161a6d6f30ac1923a15137e39709778907  src/sanitize.js
12b638eb1044eee797843f435fe595c100d676f95a0bd241ecfb252800a8db71  src/storage.js
c96928a0486f74d4b7a1348e6b8a2d597ec82fb86e7bba148df4a7112fbd4ff7  src/styles.js
740f588223dc81893d90f438e4b3e62db24946131ee3f657a52dc83ee9808c6c  src/theme.js
f59c321c904f3c26884766027d4d85221a0fc9fb5d08041b0bf646cce8be63db  src/util.js
5e41f53687266282e642eaa74e878589dd77f4e171d0a7eeb75304764cdd48ce  src/view.js
```

To update: `git archive <commit> src LICENSE | tar -x -C phone/vendor/pip-clipboard`, then update the
commit and the checksums above.
