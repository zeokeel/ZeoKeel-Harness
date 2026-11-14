## 公开面检查（铁律 0）

- [ ] PR 标题、描述、评论、review 评论、commit message 中**没有**渠道/客户身份、员工姓名（含英文名/昵称/拼音）、真实域名/IP/手机号/工号/账号/密钥；
- [ ] 文案先写入临时文件，并用私有 denylist 扫描通过：
      `node scripts/check-public-text.mjs --file /tmp/public-text.md`
- [ ] 提交/编辑 PR 后再次扫描（含 GitHub 编辑历史）：
      `node scripts/check-public-text.mjs --pr <number>`
- [ ] 仓库内容检查通过：`node scripts/check-no-real-domains.mjs`

> 私有 denylist 只存在本机或 CI secret，绝不提交到本仓。详见 `AGENTS.md` §0。
