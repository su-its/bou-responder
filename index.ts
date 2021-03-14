import https from 'https'
import mqtt from 'mqtt'
import fetch from 'node-fetch'
import { bouOptions } from './config'
import { readFileSync } from 'fs'

async function getCountOfUsers () : Promise<number | null> {
  try {
    const resp = await fetch(bouOptions.endpoint + '/v1/users_in_room')
    const body = await resp.text()
    const obj = JSON.parse(body)
    if (typeof obj !== 'object' || obj === null || !obj.data) {
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

async function setupResponse () : Promise<Message> {
  const reaction = new Message()
  const count = await getCountOfUsers()
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
  /**
   * ref1. https://github.com/beebotte/bbt_node/blob/master/lib/stream.js
   * ref2. https://github.com/beebotte/bbt_node/blob/master/lib/mqtt.js
   */
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
      const t = granted[0].topic.split('/')
      if (t.length === 2) {
        console.log('Subscribed to')
        console.log('- channel:', t[0])
        console.log('- resource:', t[1])
      }
    })
    beebotteClient.on('message', async (_topic, message, _packet) => {
      const receivedMessage = JSON.parse(message.toString())

      /* Set up response message */
      const reaction = await setupResponse()
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
