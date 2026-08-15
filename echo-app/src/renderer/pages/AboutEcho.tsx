import type { AppPageProps } from '../appState'

export function AboutEchoPage({ navigate }: AppPageProps) {
  return (
    <div className="d2-about">
      <div className="d2-profile-date">Echo · 本地 AI 音乐陪伴</div>

      <div className="about-letter">
        <div className="about-greet">嗨。</div>

        <p className="about-line">
          我是 Wusix——Echo 的作者。
        </p>

        <p className="about-line">
          这不是个准备发布的产品。<br />
          是我自己想要的一个东西——<b>一个懂我歌单的朋友</b>。
        </p>

        <p className="about-line">
          我不写代码。Echo 是我和 AI 一起做的：<br />
          我定方向、写 prompt、挑每一种颜色。<br />
          花了一周多时间，改了五个版本。
        </p>

        <div className="about-divider">· · ·</div>

        <p className="about-line">
          这中间我最骄傲的事，<br />
          是 <em>学会了让它说"我不知道"</em>。
        </p>

        <div className="about-divider">· · ·</div>

        <p className="about-line compact">
          如果你觉得它像朋友——<br />
          那就是它该有的样子。
        </p>
        <p className="about-line">
          如果你觉得它哪里不对——<br />
          那也是它的一部分。它还在慢慢学习中。
        </p>

        <p className="about-line" style={{ marginTop: 22 }}>
          谢谢你打开它。
        </p>

        <div className="about-sign">
          <div className="about-sign-name">— Wusix</div>
          <div className="about-sign-date">2 0 2 6 &nbsp; 春</div>
        </div>
      </div>

      <p className="about-privacy">
        Echo 是本地应用，数据都在你电脑里。<br />
        对话内容会发给你配置的 LLM 服务——这是 LLM 工作的方式。
      </p>

      <div className="d2-about-rows">
        <div className="d2-profile-row">
          <div>
            <strong>版本</strong>
            <small>本地运行 · 不联网上传你的数据</small>
          </div>
          <span className="d2-profile-row-label">{__APP_VERSION__}</span>
        </div>
        <div className="d2-profile-row">
          <div>
            <strong>反馈与日志</strong>
            <small>由你决定是否导出</small>
          </div>
          <button className="d2-profile-row-btn" type="button" onClick={() => navigate('settings')}>打开设置</button>
        </div>
        <div className="d2-profile-row">
          <div>
            <strong>本地数据</strong>
            <small>清空前必须再次确认</small>
          </div>
          <button className="d2-profile-row-btn" type="button" onClick={() => navigate('settings')}>管理</button>
        </div>
      </div>
    </div>
  )
}
