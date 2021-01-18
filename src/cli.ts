import * as commander from 'commander'
// @ts-ignore
import cf from 'colorfy'
import { resolve } from 'path'

// @ts-ignore
import { fetchExtInfoFromClonedRepo } from 'publish-to-open-vsx/add-extension'
// @ts-ignore
import { addNewExtension, writeToExtensionsFile } from 'publish-to-open-vsx/add-extension'
// @ts-ignore
import { onDidAddExtension, readExtensionsFromFile } from 'publish-to-open-vsx/add-extension'
import { OpenVsxExtension, VSExtension } from './types/openvsx'
import {
  deprecatedExtensionsMap,
  ensureExtensionsFileAndReturnMap,
  Extension,
  findExtByNameInOpenVSX,
  getExtensionThatNotPresentOnOpenVSX,
  getExtInfoFromMicrosoftStore,
  getRepoByVsixManifest,
  isExtensionPack,
} from './utils'

// vymarkov.nodejs-devops-extension-pack
// jabacchetta.vscode-essentials
// mubaidr.vuejs-extension-pack
// formulahendry.auto-complete-tag
// afractal.node-essentials

const addExtensions = async (notAddedExtensions: VSExtension[], extensionsFile: string) => {
  if (notAddedExtensions.length === 0) {
    return
  }
  const filepath = resolve(process.cwd(), extensionsFile)
  const { extensions } = await readExtensionsFromFile(filepath)
  const repos = notAddedExtensions.map(itm => itm.repoUrl)

  const extensionsToAdd = []
  for (const repository of repos) {
    const resp = await fetchExtInfoFromClonedRepo(repository, {})
    await addNewExtension(resp.extension, resp.package, extensions)
    extensionsToAdd.push(resp.extension)
  }
  extensionsToAdd.forEach(extension => onDidAddExtension(extension))
  await writeToExtensionsFile(extensions, extensionsFile)
}

const program = commander.version('0.0.1').on('--help', () => {
  console.log('Examples:')
  console.log('')
  console.log(
    '  $ add --add-extensions-with-license --itself mubaidr.vuejs-extension-pack ./extensions.json'
  )
})

const addCommand = program.command('add <extension-name> [extensions.json]')

addCommand
  .description(
    'add extension or extension pack to extension.json to publish to Open VSX, by default command adds extensions if pack meet all conditions only'
  )
  .option(
    '--add-extensions-with-license',
    'Add extensions that have license even if extension pack contains extensions without license'
  )
  .option(
    '--itself',
    'Add extension pack to extensions list, this value is true by default if all extensions are present in Open VSX registry'
  )
  .action(async (name: string, extensionsFile: string, program) => {
    try {
      const extensionsToAdd: VSExtension[] = []
      const extPackInfo: Extension = await getExtInfoFromMicrosoftStore(name)
      const repo = await getRepoByVsixManifest(extPackInfo)

      const [publisher, extname] = name.split('.')
      const ext: OpenVsxExtension = (await findExtByNameInOpenVSX(
        publisher,
        extname
      )) as OpenVsxExtension
      if (!('notFound' in ext)) {
        console.log(
          `Extension is already published! https://open-vsx.org/extension/${ext.namespace}/${ext.name}`
        )
        process.exit(0)
      }

      if (await isExtensionPack(name)) {
        const openVsxExtensionList: Map<
          string,
          { id: string }
        > = await ensureExtensionsFileAndReturnMap(extensionsFile)
        const {
          all,
          notFoundWithlicense,
          notFoundWithoutlicense,
          deprecatedExtensions,
          dontMeetConditions,
        } = await getExtensionThatNotPresentOnOpenVSX(name, openVsxExtensionList)

        let info: VSExtension | undefined
        let idx = notFoundWithlicense.findIndex(itm => itm.name === name)
        if (idx !== -1) {
          info = notFoundWithlicense.splice(idx, 1).shift()
        }
        idx = notFoundWithoutlicense.findIndex(itm => itm.name === name)
        if (idx !== -1) {
          info = notFoundWithoutlicense.splice(idx, 1).shift()
        }

        if (dontMeetConditions.length > 0) {
          console.log(
            'Some of extensions are not open source thus can not published to Open VSX from https://github.com/open-vsx/publish-extensions'
          )
          console.log('You need to ask authors to publish extension by himself:')
          dontMeetConditions
            .filter(itm => all.has(itm))
            .map(itm => all.get(itm))
            .forEach(itm => {
              if (itm?.msmarketplaceUrl) {
                console.log(
                  cf()
                    .green(itm?.msmarketplaceUrl)
                    .colorfy()
                )
              } else if (itm?.repoUrl) {
                console.log(
                  cf()
                    .green(itm?.repoUrl)
                    .colorfy()
                )
              }
            })
        }
        console.log(' ')

        if (deprecatedExtensions.length > 0) {
          console.log(
            'Some of extensions are deprecated, you have to update extension ids in order to publish the extension pack.'
          )
          for (const id of deprecatedExtensions) {
            console.log(
              `Extension id should be updated from ${cf()
                .red(id)
                .colorfy()} to ${cf()
                .green(deprecatedExtensionsMap.get(id))
                .colorfy()}`
            )
            console.log(
              `Please ask extension pack\'s authors to update extension id at ${cf()
                .green(repo.repoUrl + '/issues')
                .colorfy()}`
            )
          }
        }
        console.log(' ')

        if (notFoundWithlicense.length > 0) {
          console.log('See below extensions that are not present in Open VSX marketplace:')
          console.log(
            `extensions with license (${notFoundWithlicense.length}):`,
            notFoundWithlicense
          )
        }

        if (notFoundWithoutlicense.length > 0) {
          console.log(
            `extensions with not identified license or license is not present (${notFoundWithoutlicense.length}):`,
            notFoundWithoutlicense
          )
          console.log(
            'Extensions without license CAN NOT BE uploaded to Open VSX registry, license must be present'
          )
          console.log('')
        }

        const allConditionsAreMet =
          !notFoundWithlicense.length &&
          !notFoundWithoutlicense.length &&
          !deprecatedExtensions.length &&
          !dontMeetConditions.length
        if (allConditionsAreMet) {
          console.log('All extensions are present in Open VSX marketplace.')
        }

        if (program.itself && info) {
          if (!info.license) {
            console.error(
              'Extension pack does not contain license, unable to add extension pack until license is present'
            )
            process.exit(1)
          }
          extensionsToAdd.push(info)
        }

        if (allConditionsAreMet || program.itself || program.addExtensionsWithlicense) {
          extensionsToAdd.push(
            ...notFoundWithlicense.filter(itm => !openVsxExtensionList.has(itm.name))
          )

          if (extensionsToAdd.length > 0) {
            console.log(`Adding extensions with defined license to ${extensionsFile}`)
            await addExtensions(extensionsToAdd, extensionsFile)
          }
        }
      } else {
        console.log('Adding extension by name is not supported!')
      }
    } catch (err) {
      console.error(err)
      console.error(err.message)
    }
  })

program.parse(process.argv)
