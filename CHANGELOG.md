# Changelog

## [0.2.0](https://github.com/srizzling/valve-controller/compare/valve-controller-v0.1.0...valve-controller-v0.2.0) (2026-10-24)


### Features

* **rain:** catch up and force the run after a rain skip ([#11](https://github.com/srizzling/valve-controller/issues/11)) ([756d4e7](https://github.com/srizzling/valve-controller/commit/756d4e7d6aa415941baae4f0af64411ee50c66ed))
* **tuya:** reconnect from the UI, two logins, fix refresh race ([#7](https://github.com/srizzling/valve-controller/issues/7)) ([3610670](https://github.com/srizzling/valve-controller/commit/3610670e804f7c7f8b8fa99858cf8b190f3b09ad))
* **weather:** vote of 7 models for current conditions ([#10](https://github.com/srizzling/valve-controller/issues/10)) ([4fea68a](https://github.com/srizzling/valve-controller/commit/4fea68a2ec4830022f3d9a0f722bc7cbaf13be19))


### Bug Fixes

* **deps:** override undici to 7.30.1 ([#12](https://github.com/srizzling/valve-controller/issues/12)) ([c13622f](https://github.com/srizzling/valve-controller/commit/c13622fad30f9e0a783b3faf063a900a6b8b24a2))
* **smart:** raise the default soil wet threshold to 0.40 ([#13](https://github.com/srizzling/valve-controller/issues/13)) ([feee8cc](https://github.com/srizzling/valve-controller/commit/feee8cca01a8a1c095ae69247c120e378cefb126))
* **ui:** make the reconnect chip clickable ([#9](https://github.com/srizzling/valve-controller/issues/9)) ([90a2dba](https://github.com/srizzling/valve-controller/commit/90a2dbabd75108231259dc644298c0af9638ddab))
* **ui:** show rain and hose spray ([#14](https://github.com/srizzling/valve-controller/issues/14)) ([96b15d2](https://github.com/srizzling/valve-controller/commit/96b15d2b6b273e8de97489d3789c09676258844e))

## 0.1.0 (2026-10-22)


### Features

* **access:** ✨ protect UI and API with Access ([bb3dc5b](https://github.com/srizzling/valve-controller/commit/bb3dc5b4f4c15ceb907f06709e5286b5edae63cf))
* **alerts:** ✨ add heartbeat and preflight alerts ([ad5dbe4](https://github.com/srizzling/valve-controller/commit/ad5dbe48e645dab11d2aba41161f75fb112ca185))
* **arch:** ✨ export the diagram as a picture ([dce1c1f](https://github.com/srizzling/valve-controller/commit/dce1c1fb3fbbc5a665824ac52a8da32c3bccc400))
* **infra:** ✨ add Terraform ([913f16e](https://github.com/srizzling/valve-controller/commit/913f16e3bc3efa5834d022533a168c68a15013b4))
* **infra:** ✨ keep state in an R2 bucket ([6d2647f](https://github.com/srizzling/valve-controller/commit/6d2647fd2891fbe0250425a9ef4ca7badc06c165))
* **infra:** ✨ manage the Zero Trust org ([1e289c0](https://github.com/srizzling/valve-controller/commit/1e289c076f342db0f299b8aab507c4a0b96fe3cf))
* **infra:** ✨ narrow Terraform token script ([34bec3a](https://github.com/srizzling/valve-controller/commit/34bec3a16d22a45b8f574054354c88816b1c9316))
* **infra:** ✨ one-time setup script ([0ab04a0](https://github.com/srizzling/valve-controller/commit/0ab04a026f06d85e00c30d8711f3a9d1e4ae4f35))
* **schedule:** ✨ default to dawn and dusk starts ([e415650](https://github.com/srizzling/valve-controller/commit/e415650fddeec0b60b01b9a839574c8083dd86b9))
* **schedule:** ✨ extra run on hot days only ([7cf9118](https://github.com/srizzling/valve-controller/commit/7cf9118bb652da3973aa99039e4ebd79505e0c0a))
* **schedule:** ✨ start before or after sunset ([701fb0c](https://github.com/srizzling/valve-controller/commit/701fb0c0442a20b1d7aaa62807ebf2cea44d38d9))
* **security:** CSP, security headers, locked-down repo, Release Please ([#2](https://github.com/srizzling/valve-controller/issues/2)) ([441ca81](https://github.com/srizzling/valve-controller/commit/441ca8155095e8c8521974e4ee6a8a1b63149864))
* **smart:** ✨ scale cycles by weather ([63867a6](https://github.com/srizzling/valve-controller/commit/63867a657e7c94ca9ffc84c31bd071baf2bbf8d3))
* **supervisor:** force-close after one hour ([#1](https://github.com/srizzling/valve-controller/issues/1)) ([71a5cb4](https://github.com/srizzling/valve-controller/commit/71a5cb48c8904f81921bc7f68323b8a1477a25bc))
* **tuya:** ✨ control the valve via Tuya cloud ([d99f42a](https://github.com/srizzling/valve-controller/commit/d99f42a6e94da70597c2ec8d16e276c4e9afa1f9))
* **tuya:** ✨ get the key with a QR login ([5e1b371](https://github.com/srizzling/valve-controller/commit/5e1b37136e7ecc729d2294bf8327f11686c8f319))
* **tuya:** ✨ script to find the valve and key ([005206d](https://github.com/srizzling/valve-controller/commit/005206d744bcd71b2bbf62dfe17b7245775673dd))
* **ui:** ✨ animated garden dashboard ([cfbbabe](https://github.com/srizzling/valve-controller/commit/cfbbabe5041a0183ce36904d0de0943378aa93eb))
* **ui:** ✨ robot gardener and flower bed ([0d0640a](https://github.com/srizzling/valve-controller/commit/0d0640acff6b5834fa34dd8db543ed0b92caaa66))
* **ui:** ✨ robot holds a hose ([d5bf00e](https://github.com/srizzling/valve-controller/commit/d5bf00efbccf9ceaf32e34fc3aedbb974fcaf846))
* **ui:** ✨ show the valve status ([ffed432](https://github.com/srizzling/valve-controller/commit/ffed432ea675e76faa6745ab0b5c17259ad1c627))
* **ui:** ✨ show watering per forecast day ([0bc4192](https://github.com/srizzling/valve-controller/commit/0bc4192a5b9c910c0805f6487603f8a824388d2c))
* **ui:** new moon, sleeping sunflower ([#3](https://github.com/srizzling/valve-controller/issues/3)) ([89f1201](https://github.com/srizzling/valve-controller/commit/89f12013ef6f7113181eaf9ec2f947b1c2016e7b))
* **valve:** ✨ add cycle and soak controller ([1d6f6de](https://github.com/srizzling/valve-controller/commit/1d6f6de1fbfdee1b490dfaf7e551199e8d9370ca))


### Bug Fixes

* **infra:** 🐛 find zone with either token ([a7574dc](https://github.com/srizzling/valve-controller/commit/a7574dc67f4a053c712f0a9d063ced771b02faa1))
* **infra:** 🐛 two-step Durable Object deploy ([4348e91](https://github.com/srizzling/valve-controller/commit/4348e917d0f8f5916f6a4e76a75f6912505efbfb))
* **tuya:** 🐛 try Central Europe first ([0ea7301](https://github.com/srizzling/valve-controller/commit/0ea73010b643a51e28d84d3bf931425d7811df2c))
* **ui:** 🐛 bring back the robot, make it bigger ([3409f81](https://github.com/srizzling/valve-controller/commit/3409f81fab197f5e567bfcf82bb2480697450969))
* **ui:** 🐛 clearer weather reasons, no bed ([ef6ba67](https://github.com/srizzling/valve-controller/commit/ef6ba67e1e0374cdf63cb4e00a6688dcd1726a50))
* **ui:** 🐛 draw drip irrigation, not a can ([aa0277f](https://github.com/srizzling/valve-controller/commit/aa0277fc91c1b9589bf5c78f2e078eea5a1ddbc5))
* **ui:** 🐛 hose sprays rather than drips ([08022bb](https://github.com/srizzling/valve-controller/commit/08022bbb39ba62ad1765bfdc5ed5c7b2019f67cc))
* **ui:** 🐛 keep the sunflower head in view ([2b7ce45](https://github.com/srizzling/valve-controller/commit/2b7ce450e13c796e636d5826a41c95f976aa64a1))
* **weather:** cache forecast, retry timeouts, honest sky ([#4](https://github.com/srizzling/valve-controller/issues/4)) ([5f16cc8](https://github.com/srizzling/valve-controller/commit/5f16cc88a506031cd7943bd1f295e2a554f3b8c5))
