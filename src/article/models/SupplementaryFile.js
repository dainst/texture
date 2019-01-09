import { DocumentNode, STRING, CHILDREN } from 'substance'

export default class SupplementaryFile extends DocumentNode {
  static getTemplate () {
    return {
      type: 'supplementary-file',
      legend: [{ type: 'paragraph' }]
    }
  }
}

SupplementaryFile.schema = {
  type: 'supplementary-file',
  label: STRING,
  mimetype: STRING,
  href: STRING,
  legend: CHILDREN('paragraph')
}
