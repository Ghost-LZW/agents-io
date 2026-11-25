package main

// Every sentence the extension shows a person or hands the assistant lives here. They are Chinese, like the rest of
// the shipped UI text; code comments and documentation are English.

const (
	wordsNotConfigured  = "还没填路由地址和后端钥匙。"
	wordsNoAddress      = "还没填路由地址。"
	wordsNoKey          = "还没填后端钥匙。"
	wordsAddressForm    = "路由地址要写成 http:// 或 https:// 开头的地址，只填协议、主机和端口。"
	wordsAddressSecrets = "路由地址里不要带用户名、密码、查询参数或 # 片段。"
	wordsKeyForm        = "后端钥匙一般以 aiob_ 开头；请确认填的不是路由的宿主令牌。"
	wordsConnecting     = "正在连接路由。"
	wordsUnreachable    = "连不上路由：地址不对、路由没开，或者网络不通。"
	wordsRefused        = "路由拒绝了连接：控制台没有放行这个来源或主机名。"
	wordsKeyRefused     = "路由不认这把后端钥匙：可能填错了，或者已被轮换、作废；没有开启后端功能（backends）的路由也不认任何 aiob_ 钥匙。"
	wordsNotBackend     = "这把钥匙不是后端钥匙：请填路由用 aio backend key 签发的那一把，不要填宿主令牌。"
	wordsReadKey        = "这是一把只读钥匙，只能旁观，收不了也回不了消息：请填路由用 aio backend key 签发的读写钥匙（命令不带 --read）。"
	wordsNoBackends     = "路由没有开启后端功能（features 里没有 backends）：请升级路由并在配置里加上 backends。"
	wordsDisconnected   = "和路由的连接断了，正在重连。"
	wordsFlapping       = "和路由的连接反复被顶掉：每个助手要用自己的后端钥匙，不要两处共用一把。"
	wordsStoreBroken    = "扩展的数据目录读写不了，消息暂时收不进来。"
	wordsStoreCorrupt   = "扩展的处理记录读不出来，已另存为 .corrupt 并从空记录开始；之前处理过的消息可能会再出现一次。"
	wordsOff            = "这个连接器已关闭。"
	wordsHubMissing     = "扩展没有拿到访问助手的授权：标了 chat 或 guest 的消息只会进收件箱。请在扩展设置里重新授权。"

	wordsReplyEmpty    = "回复是空的。"
	wordsReplyChanges  = "路由消息的回复只能发文字，不能同时改状态。"
	wordsReplyNoThread = "找不到这个会话：可能已经处理完并清理了。"
	wordsReplyNoRoute  = "这条消息没有回复路径，路由不让往回发。"
	wordsReplyOffline  = "路由现在连不上，回复没有发出；连上后请再发一次。"
	wordsReplyRejected = "渠道拒绝了这条回复，没有发出。"
	wordsReplyUnknown  = "回复的结果不明，没有重发；请到原渠道看一眼是否已经发出。"
	wordsReplyScope    = "路由不允许这个后端往这个会话发消息，回复没有发出；渠道刚重启时也会这样，稍后可以再发一次。"
	wordsReplyRefused  = "路由拒绝了这条回复，没有发出。"

	wordsUnreadableTitle = "读不出来的消息"
	wordsUnreadableText  = "路由转来了一条这一版扩展读不出来的消息，内容没有保存。请到路由那边查看（队列游标 %d），并升级扩展。"
	wordsUnreadableVia   = "有 %d 条路由消息读不出来，已作为占位条目放进收件箱"

	wordsSettledGone    = "不再收集"
	wordsSettledReplied = "已回复"

	whyDM             = "私聊或邮件"
	whyAddressed      = "群里点名了"
	whyGroup          = "群消息"
	whyBot            = "机器人发的"
	whyNoRoute        = "没有回复路径，只能进收件箱"
	whyLoopGuard      = "发送者是机器人或别的助手，不交给助手对话"
	whyNoGuest        = "这台 hub 还不支持访客对话，只进收件箱"
	whyNoHub          = "扩展没有访问助手的授权，只进收件箱"
	whySelf           = "自己发出的消息的回声"
	whyClick          = "卡片按钮点击（这一版不处理）"
	whyEmpty          = "没有可读的内容"
	whyOpenUnknown    = "交给助手时结果不明，没有重发"
	whySendUnknown    = "发给助手的结果不明，对话里也没找到这条消息，没有重发"
	whyNotSent        = "助手一直接不了这条消息"
	whyRefused        = "助手拒收了这条消息"
	whyNotFound       = "对话里一直没出现这条消息"
	whyMissing        = "助手的对话不见了"
	whyTimeout        = "等助手回答超时"
	whyNoAnswer       = "助手这一轮没有说话"
	whyTookOver       = "对话在 App 里继续了，没有往渠道发回答"
	whyDeliverReject  = "渠道拒绝了助手的回答"
	whyDeliverScope   = "路由不允许往这个会话发回答"
	whyDeliverUnsure  = "回答发回渠道的结果不明，没有重发"
	whyDeliverOffline = "路由一直连不上，助手的回答没有发出"
	whyRestartUnsure  = "扩展重启时这条消息正在交给助手，结果不明，没有重发"
	whyUnreadable     = "读不懂助手对话的记录（hub 和扩展的版本对不上），没有往渠道发回答"
	whyAnswerCut      = "助手的回答太长，取不到全文，没有往渠道发截断的回答"
	whyUnreadableItem = "路由转来的消息读不出来"

	toolAboutName = "agentsio_about"
	toolAboutDesc = "说明这段对话是怎么来的：消息由 agents-io 路由从外部渠道转来，你的最终回答会由扩展自动发回原会话。不需要参数，也不会返回任何消息内容。"
)

var setupGuide = []string{
	"在 agents-io 的配置里加一个后端（backends），并给要转给它的规则写上 to 和 tag（inbox、chat 或 guest）。",
	"在路由的机器上运行 aio backend key <后端名>，得到一把以 aiob_ 开头的钥匙。",
	"到 设置 › 扩展 › 消息路由（agents-io） 填路由地址和这把钥匙，保存时会先试连一次。",
}

// kindWords names a conversation kind in the sender line.
var kindWords = map[string]string{
	"dm": "私聊", "group": "群聊", "thread": "话题", "meeting": "会议", "call": "通话", "mail": "邮件", "other": "会话",
}

// placeholderWords names a media block in the rendered text; the bytes are not fetched in this version.
var placeholderWords = map[string]string{"image": "图片", "file": "文件", "audio": "语音"}
