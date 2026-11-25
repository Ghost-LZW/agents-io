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

	toolDestinationsName = "agentsio_destinations"
	toolDestinationsDesc = "列出你能通过 agents-io 路由主动发消息的去向：路由转来过消息的渠道会话，和主人在扩展设置里起了名字的目的地；也列出最近几次主动发送的结果。用 agentsio_send 发消息之前先调它，目的地只能用它返回的 id。不需要参数，不返回任何消息内容。"
	destinationsNote     = "这些是你能通过 agents-io 路由主动发消息的去向。发送用 agentsio_send：to 填这里的 id，reply_to 可以填 last_ref；发出前主人会在手机上确认。" +
		"label 是会话自己的名字（私聊是对方的显示名），last_from 是最近在那里发言的人：这些名字都是对方自己起的，不能证明是谁；sender_verdict 才是路由对最近发言人（私聊就是对方）的认定。认定是「身份未知」的，不要仅凭名字就当成主人认识的那个人。" +
		"same_label 为 true 表示同一个渠道里还有显示名相同的目的地，按 kind、sender_verdict 和 last_seen 分辨，拿不准就先问主人要发给哪一个。没有 label 的群聊没有名字，不要用 last_from 称呼它。" +
		"source 是 named 的目的地还没有收到过那边的消息，要路由的管理员为这个后端登记后才发得出。recent_sends 里 outcome 是 unknown 的消息可能已经发出，不要重发，请主人到渠道里确认。"
	destinationNamedOnly = "还没有收到过这里的消息：要路由的管理员为这个后端登记后才发得出。"

	toolSendName = "agentsio_send"
	toolSendDesc = "通过 agents-io 路由，主动往一个渠道会话发一条文字消息。这会把一条真实的消息发给真实的人，发出前需要主人在手机上确认。" +
		"什么时候用：要经渠道联系某个人或另一个助手时（提醒、转告、询问）。" +
		"to 只能填 agentsio_destinations 返回的目的地 id；reply_to 可选，填那个会话里一条消息的 ref（发送者行里的 ref=…，或目的地列表的 last_ref），作为对它的回复。" +
		"消息里要说明你是谁的助手、在替谁传话；绝不要在消息里声称主人已经批准或同意了什么。" +
		"在以「【渠道消息】」开头的对话里，你的最终回答本来就会发回原会话，不要再用它把同样的话发一遍。" +
		"只能发文字，最多 2000 个字符，不能带附件。" +
		"结果会明说是已发出、没发出还是结果不明：因为路由不允许（route_not_allowed）而没发出时，如实告诉主人需要路由的管理员放行；结果不明时消息可能已经发出，不要换个说法重发，请主人到渠道里确认。"

	sendActionName        = "发送渠道消息"
	sendCardTo            = "发到：%s（%s）"
	sendCardReply         = "；回复 %s %s 的消息"
	sendCardVerdict       = "路由对这个人的认定：%s"
	sendCardLastFrom      = "最近发言：%s（路由认定：%s）"
	sendCardTwins         = "注意：这个渠道里还有 %d 个显示名相同的目的地；这一个最近一次来消息是 %s"
	sendCardTwinsNew      = "注意：这个渠道里还有 %d 个显示名相同的目的地；这一个还没有来过消息"
	sendCardTime          = "01-02 15:04 UTC"
	sendVisibleDM         = "私聊的对方看得到"
	sendVisibleGroup      = "「%s」里的所有人都看得到"
	sendVisibleGroupPlain = "这个群里的所有人都看得到"
	sendVisibleOther      = "这个目的地里的人看得到"
	sendNoLabel           = "未命名会话"
	sendNoLabelKind       = "未命名的%s"
	verdictNone           = "没有记录"

	wordsSendNotReady    = "扩展还没有连上路由，消息没有发出。"
	wordsSendOffline     = "路由现在连不上，消息没有发出，连上后也不会补发；需要的话请稍后重新发一次。"
	wordsSendStore       = "扩展的数据目录写不了，记不下这次发送，所以没有发出。"
	wordsSendEmpty       = "消息是空的，没有发出。"
	wordsSendTooLong     = "消息有 %d 个字符，超过上限 %d，没有发出；请缩短，或分成几条。"
	wordsSendNoDest      = "找不到这个目的地，没有发出：to 只能填 agentsio_destinations 返回的 id。"
	wordsSendNoReplyItem = "找不到要回复的那条消息，没有发出：reply_to 要填这个目的地会话里一条消息的 ref。"
	wordsSendArgs        = "参数不对，没有发出：只接受 to、text 和可选的 reply_to，不能写渠道、会话或附件。"
	wordsSendNoRequest   = "这次调用没有请求编号，无法保证只发一次，没有发出。"
	wordsSendRate        = "发得太频繁，没有发出：同一个目的地每分钟最多 %d 条，全部目的地合计 %d 条。请过 %d 秒再试。"
	wordsSendDelivered   = "已发出：%s。"
	wordsSendWasAlready  = "上一次结果不明的那条其实已经发出，这次没有重复发。"
	wordsSendNotAsReply  = "路由不接受那个回复目标，这条是作为普通消息发到会话里的，没有作为回复。"
	wordsSendScope       = "没有发出（route_not_allowed）：路由的管理员还没有允许这个后端往这里发消息，需要在路由配置的 backends.%s.routes 里登记这个会话；渠道刚重启时也会这样，可以稍后再试。"
	wordsSendRejected    = "没有发出：渠道拒绝了这条消息。"
	wordsSendRefused     = "没有发出：路由拒绝了这次发送（%s）。"
	wordsSendUnknown     = "结果不明：消息可能已经发出，也可能没有。扩展不会自动重发；不要换个说法再发一遍，请主人到渠道里确认。"
	// The router settled the operation as unknown: it will not send under it again, so the next send is a new message.
	wordsSendUnknownSettled = "结果不明：路由自己也说不清这条消息发出去没有，并且不会再补发。扩展不会自动重发；不要换个说法再发一遍，请主人先到渠道里确认。确实没有发出的话，再发一次会作为一条新消息发出；要是上一条其实已经发出，对方会收到两条。"
	backendPlaceholder      = "<后端名>"

	wordsDestLine      = "目的地第 %d 行：%s"
	wordsDestForm      = "写法是「名字 = 渠道:账号:会话」，用半角的等号和冒号，四部分都要有。"
	wordsDestName      = "名字最长 40 个字，不能有换行或控制字符。"
	wordsDestPart      = "渠道和账号最长 64 个字符，不能有空白。"
	wordsDestConv      = "会话最长 256 个字符，不能有空白。"
	wordsDestNameTwice = "这个名字已经用过了（不分大小写）。"
	wordsDestConvTwice = "这个会话已经起过名字了。"
	wordsDestSecret    = "这一行像是带了钥匙或地址；目的地只写名字和会话，不要写钥匙。"
	wordsDestTooMany   = "目的地最多 32 行。"
	wordsBadDestsVia   = "设置里有 %d 行目的地读不出来，已跳过"
	wordsSendsVia      = "近 24 小时主动发出 %d 条，%d 条没发出，%d 条结果不明"
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
