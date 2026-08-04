import { Logger, Collection } from '@freearhey/core'
import { Storage } from '@freearhey/storage-js'
import epgGrabber, { EPGGrabber } from 'epg-grabber'
import { Channel } from '../../models'
import { SITES_DIR } from '../../constants'
import { Option, program } from 'commander'
import axios from 'axios'
import path from 'path'

program
  .addOption(
    new Option('-u, --url <url>', 'M3U playlist URL from iptv-org/iptv')
      .makeOptionMandatory()
  )
  .addOption(
    new Option('-d, --days <number>', 'Number of days to look ahead')
      .default(2)
      .argParser((val) => parseInt(val, 10))
  )
  .parse()

interface SyncOptions {
  url: string
  days: number
}

const options: SyncOptions = program.opts()
const OUTPUT_DIR = path.join(process.cwd(), 'output')

// Define site priorities (lower index = higher priority)
const SITE_PRIORITY = ['zee5.com', 'dishtv.in', 'airtelxstream.in', 'tataplay.com']

function getSitePriorityIndex(site: string | undefined): number {
  if (!site) return Infinity
  const index = SITE_PRIORITY.indexOf(site)
  return index === -1 ? Infinity : index
}

function escapeXml(unsafe: string): string {
  return unsafe.replace(/[<>&'"]/g, (c) => {
    switch (c) {
      case '<': return '&lt;'
      case '>': return '&gt;'
      case '&': return '&amp;'
      case '\'': return '&apos;'
      case '"': return '&quot;'
      default: return c
    }
  })
}

async function main() {
  const logger = new Logger()
  logger.start('Starting M3U Channel Target Generator...')

  // 1. Fetch and Parse M3U for tvg-ids
  logger.info(`Fetching M3U playlist from: ${options.url}`)
  let m3uContent = ''
  try {
    const response = await axios.get(options.url)
    m3uContent = response.data
  } catch (err: any) {
    logger.error(`Failed to fetch M3U: ${err.message}`)
    process.exit(1)
  }

  const targetTvgIds = extractTvgIds(m3uContent)

  // 2. Load all available channels across the workspace registries
  const allWorkspaceChannels = await loadWorkspaceChannels()

  // 3. Intersect channels, apply priority rules, and eliminate duplicates
  const bestChannelMap = new Map<string, Channel>()
  const mappedM3uIds = new Set<string>()

  allWorkspaceChannels.forEach((channel: Channel) => {
    if (channel.xmltv_id && targetTvgIds.has(channel.xmltv_id)) {
      mappedM3uIds.add(channel.xmltv_id)

      const existingMatch = bestChannelMap.get(channel.xmltv_id)
      if (!existingMatch) {
        // First time seeing this xmltv_id, store it
        bestChannelMap.set(channel.xmltv_id, channel)
      } else {
        // Compare site priorities to pick the absolute best one
        const currentPriority = getSitePriorityIndex(channel.site)
        const existingPriority = getSitePriorityIndex(existingMatch.site)

        if (currentPriority < existingPriority) {
          bestChannelMap.set(channel.xmltv_id, channel)
        }
      }
    }
  })

  const matchedChannels = new Collection<Channel>()
  bestChannelMap.forEach((channel) => matchedChannels.add(channel))

  // Calculate statistics metrics
  const totalM3uChannels = targetTvgIds.size
  const totalMappedChannels = mappedM3uIds.size
  const totalUnmappedChannels = totalM3uChannels - totalMappedChannels

  logger.info('--------------------------------------------')
  logger.info(` M3U Playlist Total Channels: ${totalM3uChannels}`)
  logger.info(` Channels Mapped to Sites:    ${totalMappedChannels}`)
  logger.info(` Channels Missing in EPG:     ${totalUnmappedChannels}`)
  logger.info('--------------------------------------------')

  if (matchedChannels.count() === 0) {
    logger.error('No overlapping channel mappings found between your M3U and local site targets!')
    process.exit(1)
  }

  // 4. Save dynamically filtered channel configuration file
  const xmlChannelsPayload = matchedChannels.all().map(c => {
    const cleanName = escapeXml(c.name || '')
    return `  <channel site="${c.site}" site_id="${c.site_id}" lang="${c.lang}" xmltv_id="${c.xmltv_id}">${cleanName}</channel>`
  }).join('\n')

  const rawXmlFileContent = `<?xml version="1.0" encoding="UTF-8"?>\n<channels>\n${xmlChannelsPayload}\n</channels>`

  const outputStorage = new Storage(OUTPUT_DIR)
  await outputStorage.save('channels.xml', rawXmlFileContent)

  // 5. Manifest worker.json metadata structure
  const workerMetadata = {
    channels: 'channels.xml',
    guide: {
      xml: 'guide.xml',
      gzip: 'guide.xml.gz',
      json: 'guide.json'
    }
  }
  await outputStorage.save('worker.json', JSON.stringify(workerMetadata, null, 2))

  logger.success('Channels generation complete! Target saved to output/channels.xml')
}

function extractTvgIds(m3u: string): Set<string> {
  const ids = new Set<string>()
  const lines = m3u.split('\n')
  const tvgIdRegex = /tvg-id="([^"]+)"/i

  for (const line of lines) {
    if (line.startsWith('#EXTINF')) {
      const match = line.match(tvgIdRegex)
      if (match && match[1]) {
        ids.add(match[1].trim())
      }
    }
  }
  return ids
}

async function loadWorkspaceChannels() {
  const sitesStorage = new Storage(SITES_DIR)
  const files: string[] = await sitesStorage.list('**/*.channels.xml')
  const channels = new Collection<Channel>()

  for (const filepath of files) {
    const xml = await sitesStorage.load(filepath)
    const parsedChannels = EPGGrabber.parseChannelsXML(xml)
    const channelsFromXML = new Collection(parsedChannels).map(
      (channel: epgGrabber.Channel) => new Channel(channel.toObject())
    )
    channelsFromXML.forEach((channel: Channel) => {
      channels.add(channel)
    })
  }
  return channels
}

main()
