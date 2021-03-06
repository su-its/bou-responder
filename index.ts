import https from 'https'
import mqtt from 'mqtt'
import fetch from 'node-fetch'
import YAML from 'yaml'
import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * 設置ファイルのパス
 */
const CONFIG_FILE = join(process.cwd(), 'config.yml')

/**
 * bou-responderの動作に必要な設定項目を格納したインターフェース
 */
interface BouOptions {
  /** Beebotte token */
  beebotteChannelToken: string

  /** Channel to subscribe */
  beebotteChannel: string

  /** Resource to subscribe */
  beebotteResource: string

  /**
   * Endpoint to get a list of users
   * who are currently in the room
   */
  endpoint: string
}

function getBouOptionsFromConfigYaml (filePath: string): BouOptions | null {
  try {
    // yamlの読み込み
    const loaded = YAML.parse(readFileSync(filePath, 'utf-8'))

    /**
     * 与えられた引数がBouOptionsインターフェースを実装しているかチェックするためのユーザー定義タイプガード
     *
     * @see 元ネタ {@link https://qiita.com/suin/items/0ce77f31cbaa14031288 TypeScript: interfaceにはinstanceofが使えないので、ユーザ定義タイプガードで対応する - Qiita}
     * @see TypeScriptのドキュメント {@link https://www.typescriptlang.org/docs/handbook/2/narrowing.html#using-type-predicates TypeScript: Documentation - Narrowing}
     * @param arg BouOptionsインターフェースを実装しているか確かめたいもの(オブジェクト)
     * @returns
     */
    function implementsBouOptions (arg: any): arg is BouOptions {
      return arg !== null &&
        typeof arg === 'object' &&
        typeof arg.beebotteChannelToken === 'string' &&
        typeof arg.beebotteChannel === 'string' &&
        typeof arg.beebotteResource === 'string' &&
        typeof arg.endpoint === 'string'
    }

    // BouOptions interfaceとして適切かチェック
    if (!implementsBouOptions(loaded.bouOptions)) {
      console.error(`[!] The setting value is incorrect or insufficient. Check '${filePath}'.`)
      return null
    }
    return loaded.bouOptions
  } catch (err) {
    // YAML.parse()のエラーをハンドリング
    console.error('[!] Error:', err)
    return null
  }
}

async function getCountOfUsers (endpoint: string) : Promise<number | null> {
  try {
    const resp = await fetch(endpoint + '/v1/users_in_room')
    const body = await resp.text()
    const obj = JSON.parse(body)
    if (obj === null || typeof obj !== 'object' || !obj.data) {
      const status = resp.status
      console.error('[!] Unexpected response with status ' + status, obj)
      return null
    }
    // return obj.length
    return obj.data.length
  } catch (e) {
    console.error('[!] Failed to get count', e)
  }
  return null
}

async function setupResponse (endpoint: string) : Promise<Message> {
  const reaction = new Message()
  const count = await getCountOfUsers(endpoint)
  if (count === null) {
    reaction.text = 'boushitsu status: *error* (Sorry, something went wrong.) :x:'
    reaction.footer = ':bow:_< Sorry_'
  } else {
    if (count === 0) {
      reaction.text = 'boushitsu status: *closed* :zzz:'
      reaction.footer = 'No one is currently in the room.'
    } else {
      reaction.text = 'boushitsu status: *open* :heavy_check_mark:'
      reaction.footer = 'Currently in the room ' + ':bust_in_silhouette:'.repeat(count)
    }
  }
  return reaction
}

class Message {
  text: string
  footer: string

  constructor () {
    this.footer = ''
    this.text = ''
  }

  postEphemeralTo (url: string) {
    const payload = {
      text: 'from boushitsu',
      response_type: 'ephemeral',
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: this.text
          }
        },
        {
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: this.footer
            }
          ]
        }
      ]
    }

    const req = https.request(url, {
      method: 'POST',
      headers: {
        'Content-type': 'application/json'
      }
    })

    req.write(JSON.stringify(payload))
    req.end()
  }
}

function run () {
  const bouOptions = getBouOptionsFromConfigYaml(CONFIG_FILE)
  if (!bouOptions) {
    console.error('Error occurred while reading config file')
    // TODO 設定ファイルの不備で落ちたら再起動しても落ちるのは明白なので別ロジックにしたい
    process.exit(1)
  }
  /**
   * ref1. https://github.com/beebotte/bbt_node/blob/master/lib/stream.js
   * ref2. https://github.com/beebotte/bbt_node/blob/master/lib/mqtt.js
   */
  if (bouOptions.beebotteChannelToken.length === 0) {
    console.error("[!] The length of the token is zero")
    // TODO 設定ファイルの不備で落ちたら再起動しても落ちるのは明白なので別ロジックにしたい
    // そもそもprocess.exit()を多用すべきではない
    process.exit(1)
  }
  const mqttAuth = {
    username: 'token:' + bouOptions.beebotteChannelToken,
    password: '',
    ca: [readFileSync('./mqtt.beebotte.com.pem')] // I'm not sure if 'ca' is needed or not.
  }

  const mqttUrl = 'mqtts://mqtt.beebotte.com:8883'
  const beebotteClient = mqtt.connect(mqttUrl, mqttAuth)

  const channel = bouOptions.beebotteChannel
  const res = bouOptions.beebotteResource

  beebotteClient.on('connect', () => {
    // Set QoS 0 or 1 (2 unavailable) if too many messages are posted.
    beebotteClient.subscribe(channel + '/' + res, { qos: 1 }, (err, granted) => {
      if (err) {
        console.error('[!] Error on subscription', err)
        process.exit(-1)
      }
      if (!granted) {
        console.error('[!] "granted" is undefined. Failed to subscribe.')
        process.exit(-1)
      }
      if (!Array.isArray(granted) || granted.length === 0) {
        console.error('[!] "granted" is not an array or it has no element. "granted":', granted)
        process.exit(-1)
      }

      const g = granted[0]
      if (!g?.topic) {
        // TODO: find why this occurs
        console.error('[!] "topic" is undefined. Failed to subscribe.')
        process.exit(-1)
      }

      const t = g.topic.split('/')
      if (t.length === 2) {
        console.log('Subscribed to')
        console.log('- channel:', t[0])
        console.log('- resource:', t[1])
      }
    })
    beebotteClient.on('message', async (_topic, message, _packet) => {
      const receivedMessage = JSON.parse(message.toString())

      /* Set up response message */
      const reaction = await setupResponse(bouOptions.endpoint)
      /**
       * ref. https://api.slack.com/interactivity/slash-commands
       */
      reaction.postEphemeralTo(receivedMessage.data.response_url)
    })
  })

  beebotteClient.on('error', err => {
    console.error('[!] Error on connect', err)
    process.exit(-1)
  })
}

run()
