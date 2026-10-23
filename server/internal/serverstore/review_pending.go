package serverstore

import (
	"database/sql"
	"errors"
)

// ErrAppDelisted 表示写入面被**下架冻结**（第五轮审计 R5-B-1，2026-09-23）。
//
// 语义权威在 distribution.go 的 Distribution.Writable()：App 处于下架态
// （apps.enabled=0）时，上传与审核通过一律拒绝 —— 否则会产出「已批准但任何
// 人（含作者）都看不见」的版本，作者反复提交、管理员反复批准，使用侧毫无变化。
// 出口是管理员**显式重新上架**（带审计），不是审批时自动上架。
//
// 与 appstore.CodeAppDelisted 同码同语义（"APP_DELISTED"），HTTP 层由调用方
// 映射成 409；定义在 serverstore 是因为审核路径（本文件）与发布内核两边都要
// 用它，而 serverstore 是这两者的共同底座（appstore 反过来依赖 serverstore）。
var ErrAppDelisted = errors.New("app delisted")

// ReviewPending 是审核落定（approve / reject）的**唯一实现**。
//
// 为什么收敛到一处（2026-10-23「已上架技能无法更新」修复）：
// 审核路径此前有两份（sharedskills 的组织共享库、agentshare 的组织预设），
// 而市场渠道的「员工提交待审 → 管理员审批」这一条**根本不存在**。修复后市场
// 待审版本要走同一条落定语义（状态 + 投影重算 + 下架冻结），因此把它抽成
// serverstore 的一个函数，三面共用：语义只有一份，不会再出现「一个面记得重算
// 投影、另一个面忘了」的裂缝。
//
// 语义：
//   - approve：先过下架冻结（Distribution.Writable()，唯一判据），再
//     pending→approved；`rejected` 且归档已释放的行由 SetReleaseStatusForReview
//     回 ErrReleaseArchiveCleared（拒绝即释放存储，不能再通过）；
//   - reject：只对**未生效**版本成立（DAO 的 `status <> 'approved'` 前置条件，
//     审计 2026-09-23 ID-01）；拒绝与释放归档在同一条 UPDATE 里完成。
//   - 两种落定之后都**必须**重算 apps 行的展示投影（审计 2026-09-23 G-P2-3）：
//     apps 是目录对全员下发的投影，app_releases 才是真相；不重算就会出现
//     「批准了却永远看不到新标题」/「拒绝后旧标题永久留在目录上」。
//
// 返回的哨兵错误由 HTTP 层映射：
//   - ErrNotFound：版本不存在（或已软删）⇒ 404；
//   - ErrAppDelisted：approve 打到已下架 App ⇒ 409 APP_DELISTED；
//   - ErrReleaseArchiveCleared：待审版本已被拒绝过（归档释放）⇒ 409 ARCHIVE_CLEARED；
//   - ErrReleaseApprovedNotRejectable：reject 打到已生效版本 ⇒ 409。
//
// 注意：**渠道守卫不在本函数里**。本函数只认 (kind, appID, version)，两个审核
// 入口各自负责证明目标行属于自己服务的渠道（组织库 org / 市场 market），
// 与既有 channel.go 的守卫同源。
func ReviewPending(db *sql.DB, kind, appID, version string, approve bool, reason string) error {
	if approve {
		dist, err := AppDistribution(db, kind, appID)
		if err != nil {
			return err
		}
		if !dist.Writable() {
			return ErrAppDelisted
		}
		if err := SetReleaseStatusForReview(db, kind, appID, version, ReleaseStatusApproved, ""); err != nil {
			return err
		}
	} else {
		if err := SetReleaseStatusForReview(db, kind, appID, version, ReleaseStatusRejected, reason); err != nil {
			return err
		}
	}
	// 投影重算失败时状态已经落库：这不是「审核失败」而是平台侧写入故障，
	// 调用方如实回 500 让管理员重试（重试会再走到这里，幂等）。
	if _, err := RecomputeAppProjection(db, kind, appID); err != nil {
		return err
	}
	return nil
}
